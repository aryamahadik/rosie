// T-140, C7: trade text that says Rosie or Rosie's team checks, looks up or has read a license, permit, certificate,
// insurance or carrier status is the business's own word (MC C7; D96; RULES 10.1; S13-11); so is a free-text pf rule
// that waits on a paper that "checks out", or says one is "checked like a license", and names no one who checks (the
// lead's ruling on MC C7's count, DL-884), and a pf rule with another passive wording of a paper checked by no one named
// (its ruling on round 2's open question 1, DL-894), and the same passive wordings in an op's words, a rename's new side,
// a slot row or a money text (its ruling on round 3's FAIL, DL-901). Proofs of the card that belong to C7:
//   - over all 243 trades, C7 flags the texts in the snapshot below, MC C7's five examples among them (acupuncturist,
//     camp, movers, tree, dog-walker), in 123 trade files (300 texts): 62 whose texts name Rosie or Rosie's team as the
//     one who checks (c7.ts CLAIM_PATTERNS), and 61 more whose texts only wait on, or show, a paper checked by no one
//     named (c7.ts PASSIVE_PATTERNS). The counts by round: run 1 counted 31 trade files (CLAIM_PATTERNS alone); round 2,
//     59 (the 28 passive files of DL-884: the pf.license blocks of 19 building trades; appraiser, energy-audit,
//     home-engineer, inspector, surveyor, locksmith, towing, property-manager and gym); round 3, 102 (DL-894):
//       a negation no longer reaches across a clause break, so "Where a lookup has no data feed, a person on Rosie's
//       team checks within 1 business day" (movers.json at S1-38, the security reviewer's FAIL) and the pf.license.check
//       rule "where there's none, a person on Rosie's team checks within 1 business day" of 15 repair trades are claims;
//       PAPER also reads the place a paper is checked where a lookup has no feed (a data feed, the state's own site, the
//       state's records, the city), which the line "Where a state has no data feed, a person on Rosie's team checks the
//       state's own site and keeps a screenshot" names in the words ops of 20 trades; with notary's, 30 files more
//       name Rosie or Rosie's team (61), and property-manager leaves the passive-only list;
//       PASSIVE_PATTERNS reads the other passive wordings: 14 files more (coach, cpa, dog-trainer, electrician,
//       funeral, gunsmith, hvac, lash-brow, lawyer, limo, pool-builder, realtor, speech-therapist, trainer), 41 in all;
//     round 4, 123 (DL-901): any separator ends a negation's reach ("None needed · registration checked on the state's
//       lookup, Oct 19", dance.json:8386, the round 3 FAIL); WORD_PATTERNS are read in every text but a message a person
//       reads ("None needed · registration 0628841, checked", snow.json:5512), with the scan's other passive wordings;
//       a text names a paper by its place too (a pf block's key; a rename's first side, whose "the license" a new side's
//       "it" stands for: yoga becomes the 62nd file that names Rosie), by a paper's renewal or a notary's commission:
//       20 passive files more (chimney, college-admissions, cpr-training, estate-sale, home-stager, image-consultant,
//       lawn, matchmaker, organizer, personal-shopper, photographer, pilates, private-investigator, psychic,
//       shoe-repair, tailor, tours, translator, travel-agent, upholstery), 61 in all.
//     MC C7 says the Nov 4 check listed 45 such trade files; that list is not available, so this build pins its own
//     count, 123, each phrase with its trade file's example in c7.ts (never padded or trimmed to 45);
//   - the exhaustive scan (DL-901 item 16): every hit of CLAIM_PATTERNS and PASSIVE_PATTERNS (their guards left out),
//     and every check verb with a negation within 3 words before it across a separator, that stays in a compiled text
//     is in ALLOWED with its one reason (a true negation, no paper, or lead note 12), in FIRST_SIDES, in
//     MESSAGES_WAITING (CQ-347's, DL-904) or in MESSAGES_NEED (notary.json's card, a NEED for the lead);
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
// Not here: a step that waits on a paper that checks out (movers' junk hauling, whose six messages a person reads stay
// as written; driving-school's learner's permit, which the instructor checks in person) is CQ-347's. S1-33's lines in
// Rosie's own voice ("We couldn't find barbershop license BS20981 ... on the state's lookup ... until our team checks it
// within 1 business day": 25 trade files rename the master's line, laundry, shoe-repair and upholstery keeping "our team
// checks it", and 9 carry it in the say messages of words ops at S1-33, round 2's count) sit on C4's verify-only branch,
// switched off while verify is off, so no person reads them; C4 and T-147's markers cover them, and C7 leaves them as
// written (DL-894).
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
  PASSIVE_PATTERNS,
  WORD_PATTERNS,
  c7,
  findClaims,
  markClaims,
  namedAt,
  ownWord,
  patternsAt,
  renderMarks,
  type MarkedTrade,
} from "./c7";
import { isD96Off, voidOffs } from "./c8";
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

/**
 * The 61 trade files C7 flags for a text that waits on, or shows, a paper no one named checks, and for nothing else:
 * round 3's 41, whose pf blocks say so, and 20 more whose ops or renames' new sides do (DL-901), or whose pf block names
 * the paper by its key (private-investigator).
 */
const PASSIVE_ONLY: readonly string[] = [
  "appraiser",
  "chimney",
  "closets",
  "coach",
  "college-admissions",
  "concrete",
  "contractor",
  "cpa",
  "cpr-training",
  "deck",
  "demolition",
  "dog-trainer",
  "drywall",
  "electrician",
  "energy-audit",
  "estate-sale",
  "excavation",
  "foundation",
  "funeral",
  "glass-doors",
  "gunsmith",
  "gutters",
  "gym",
  "home-engineer",
  "home-stager",
  "hvac",
  "image-consultant",
  "inspector",
  "insulation",
  "irrigation",
  "lash-brow",
  "lawn",
  "lawyer",
  "limo",
  "locksmith",
  "masonry",
  "matchmaker",
  "organizer",
  "painter",
  "paving",
  "personal-shopper",
  "photographer",
  "pilates",
  "pool-builder",
  "private-investigator",
  "psychic",
  "radon",
  "realtor",
  "roofer",
  "security",
  "shoe-repair",
  "siding",
  "speech-therapist",
  "surveyor",
  "tailor",
  "tours",
  "towing",
  "trainer",
  "translator",
  "travel-agent",
  "upholstery",
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

  it("reads a wait on a paper that checks out, or one checked like a license, as a claim in a trade's own words, never in a message a person reads (DL-901)", () => {
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
    // A paper checked with no checker named is the business's own word in an op's words, a rename's new side, a slot row
    // or a money text as in a pf block (DL-901); a message a person reads is read with CLAIM_PATTERNS alone.
    expect(patternsAt("pluginText.pf.license.blocks[0]")).toBe(WORD_PATTERNS);
    expect(patternsAt("A ops[11].does")).toBe(WORD_PATTERNS);
    expect(patternsAt("B rename[7][1]")).toBe(WORD_PATTERNS);
    expect(patternsAt("A slotRows[0].label")).toBe(WORD_PATTERNS);
    expect(patternsAt("A ops[11].say[2][0]")).toBe(CLAIM_PATTERNS);
    expect(patternsAt("A ops[13].addSay[0][1].list.rows[1][1]")).toBe(CLAIM_PATTERNS);
    // A message that waits on a permit belongs to a step that waits (CQ-347's; the lead's ruling, DL-904): read with
    // CLAIM_PATTERNS, it stays (MESSAGES_WAITING).
    const junk =
      "Junk hauling is set up, under the company's hauler permit. AI assistants can book it once the permit checks out.";
    expect(findClaims(junk, patternsAt("A ops[11].say[2][0]"))).toStrictEqual([]);
    expect(findClaims(junk, WORD_PATTERNS)).toHaveLength(1);
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

  it("reads the other passive wordings of a paper checked by no one named as a claim, never with CLAIM_PATTERNS alone (DL-894, DL-901)", () => {
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
  it("flags the texts below, MC C7's five examples among them, in 123 trade files: 62 that name Rosie or Rosie's team, 61 more with a passive wording (run 1: 31; round 2: 59; round 3: 102; MC C7: the Nov 4 check listed 45)", () => {
    expect(ALL).toHaveLength(243);
    const flagged: Record<string, string[]> = {};
    const namesRosie: string[] = [];
    for (const id of ALL) {
      const { done } = marked(id);
      const where = done.marked.map((one) => one.where);
      if (where.length > 0) flagged[id] = where;
      // A text C7 marked names a paper, in its words or by its place (namedAt): read it as one that does.
      if (done.marked.some((one) => findClaims(one.before, CLAIM_PATTERNS, true).length > 0))
        namesRosie.push(id);
    }
    for (const [id, where] of [...EXAMPLES, ...PASSIVE_EXAMPLES, ...ROUND3_EXAMPLES])
      expect(flagged[id], id).toContain(where);
    // 62 trade files name Rosie or Rosie's team as the one who checks (run 1's 31, DL-894's 30, and yoga, whose rename
    // says Rosie checks the license its first side names, DL-901); 61 more only wait on, or show, a paper no one named
    // checks (round 3's 41, and DL-901's 20); 123 in all, pinned as this build counts them (never padded or trimmed to
    // MC C7's 45, whose list is not available). 300 texts are marked (round 3: 193).
    expect(namesRosie).toHaveLength(62);
    expect(Object.keys(flagged).filter((id) => !namesRosie.includes(id))).toStrictEqual(PASSIVE_ONLY);
    expect(Object.keys(flagged)).toHaveLength(123);
    expect(Object.values(flagged).flat()).toHaveLength(300);
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
        "chimney": [
          "B rename[31][1]",
        ],
        "cleaner": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "closets": [
          "pluginText.pf.license.blocks[0]",
          "B rename[165][1]",
        ],
        "clown": [
          "B rename[5][1]",
        ],
        "coach": [
          "pluginText.pf.license.ask",
          "A ops[63].more[1]",
          "B ops[59].more[1]",
        ],
        "college-admissions": [
          "A ops[63].more[1]",
          "B ops[58].more[1]",
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
        "cpr-training": [
          "A ops[15].why",
          "B ops[13].why",
        ],
        "dance": [
          "A ops[61].form[3][1]",
          "A ops[70].does",
          "A rename[292][1]",
          "A rename[380][1]",
          "B ops[52].form[3][1]",
          "B ops[56].does",
          "B rename[349][1]",
          "B rename[437][1]",
        ],
        "daycare": [
          "A ops[5].does",
          "A ops[64].more[0]",
          "A ops[84].does",
          "B ops[6].does",
          "B ops[64].more[0]",
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
          "B ops[84].form[3][1]",
          "B rename[3][1]",
        ],
        "dog-trainer": [
          "pluginText.pf.staff.licenses",
          "A ops[3].why",
          "B ops[0].why",
          "B ops[4].why",
        ],
        "dog-walker": [
          "A ops[8].more[1]",
          "A ops[12].more[0]",
          "A ops[23].does",
          "A ops[75].more[0]",
          "A ops[78].more[1]",
          "B ops[8].more[1]",
          "B ops[12].more[0]",
          "B ops[25].does",
          "B ops[109].more[1]",
          "B ops[112].more[1]",
        ],
        "driving-school": [
          "pluginText.pf.license.blocks",
          "A ops[3].more[0]",
          "A ops[53].more[2]",
          "A ops[103].does",
          "B ops[3].more[0]",
          "B ops[60].does",
          "B ops[60].vary.before:card.does",
          "B ops[60].vary.before:deposit.does",
          "B ops[60].vary.before:full.does",
          "B ops[60].vary.before:card+after:card.does",
          "B ops[60].vary.price:list+before:full+after:none.does",
          "B ops[60].vary.price:list+before:deposit+after:card.does",
          "B ops[60].vary.price:list+before:card+after:card.does",
          "B ops[69].more[2]",
          "B ops[165].does",
        ],
        "drywall": [
          "pluginText.pf.license.blocks[0]",
          "A rename[45][1]",
        ],
        "duct-cleaning": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
          "B rename[90][1]",
        ],
        "electrician": [
          "pluginText.pf.license.local rules",
        ],
        "energy-audit": [
          "pluginText.pf.license.blocks_live",
        ],
        "estate-sale": [
          "A rename[60][1]",
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
          "A ops[24].why",
          "B ops[16].why",
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
        "home-stager": [
          "B rename[166][1]",
        ],
        "hvac": [
          "pluginText.pf.license.local rules",
        ],
        "image-consultant": [
          "A ops[63].more[1]",
          "B ops[58].more[1]",
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
          "B rename[411][1]",
          "B rename[434][1]",
        ],
        "irrigation": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "lash-brow": [
          "pluginText.pf.license.threading",
        ],
        "lawn": [
          "A ops[1].more[0]",
          "B ops[1].more[0]",
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
        "matchmaker": [
          "A ops[63].more[1]",
          "B ops[58].more[1]",
        ],
        "mortgage": [
          "pluginText.pf.license.renewals",
          "A ops[9].more[0]",
          "A rename[84][1]",
          "B ops[9].more[0]",
          "B rename[128][1]",
        ],
        "motorcycle": [
          "pluginText.pf.license.check",
        ],
        "movers": [
          "pluginText.pf.license.status_any_day",
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
          "A ops[11].does",
          "A ops[11].more[1]",
          "A ops[24].does",
          "B ops[11].does",
          "B ops[11].more[1]",
          "B ops[24].does",
        ],
        "music": [
          "pluginText.pf.license.need",
        ],
        "notary": [
          "A ops[3].does",
          "B ops[3].more[0]",
        ],
        "organizer": [
          "B rename[166][1]",
        ],
        "orthopedist": [
          "B ops[63].does",
        ],
        "painter": [
          "pluginText.pf.license.blocks[0]",
          "A rename[27][1]",
        ],
        "party-characters": [
          "B rename[5][1]",
        ],
        "paving": [
          "pluginText.pf.license.blocks[0]",
        ],
        "personal-shopper": [
          "A ops[63].more[1]",
          "B ops[58].more[1]",
        ],
        "pet-taxi": [
          "A ops[50].does",
          "B ops[20].does",
        ],
        "pet-waste": [
          "A ops[37].does",
          "A ops[39].does",
          "B ops[17].does",
          "B ops[19].does",
        ],
        "pharmacist": [
          "A ops[29].more[0]",
          "A ops[54].does",
          "B ops[28].more[0]",
          "B ops[53].does",
        ],
        "photographer": [
          "A rename[120][1]",
          "A rename[121][1]",
          "B rename[252][1]",
          "B rename[253][1]",
        ],
        "pilates": [
          "A ops[17].why",
          "A ops[68].does",
          "B ops[13].why",
          "B rename[139][1]",
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
        "private-investigator": [
          "pluginText.pf.license.renewals",
        ],
        "property-manager": [
          "pluginText.pf.license.blocks going live",
          "pluginText.pf.license.renewals",
          "A ops[5].more[1]",
          "A ops[6].more[0]",
          "B ops[5].more[1]",
          "B ops[6].more[0]",
        ],
        "psychic": [
          "A ops[62].more[1]",
          "B ops[59].more[1]",
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
          "A ops[48].does",
          "B ops[33].more[1]",
          "B ops[36].does",
        ],
        "restaurant": [
          "pluginText.pf.license.check",
          "pluginText.pf.license.renewals",
        ],
        "restoration": [
          "pluginText.pf.license.certifications",
          "A ops[26].does",
          "A rename[131][1]",
          "B ops[26].does",
          "B rename[419][1]",
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
          "A ops[6].does",
        ],
        "sharpening": [
          "pluginText.pf.license.check",
        ],
        "shoe-repair": [
          "B rename[80][1]",
        ],
        "siding": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "sitter": [
          "A ops[3].does",
          "B ops[3].does",
          "B ops[139].more[0]",
        ],
        "small-engine": [
          "pluginText.pf.license.check",
        ],
        "snow": [
          "A ops[13].more[1]",
          "A ops[54].table.rows[0][3]",
          "B ops[13].more[1]",
          "B ops[127].table.rows[0][3]",
        ],
        "speech-therapist": [
          "pluginText.pf.license.national",
        ],
        "surveyor": [
          "pluginText.pf.license.blocks_live",
        ],
        "tailor": [
          "A rename[46][1]",
        ],
        "tax": [
          "pluginText.pf.license.titles",
          "A ops[0].why",
          "A ops[5].why",
          "A ops[78].more[2]",
          "A ops[80].does",
          "A ops[96].more[1]",
          "A ops[105].does",
          "A ops[127].more[0]",
          "A ops[127].more[2]",
          "B ops[0].why",
          "B ops[5].why",
          "B ops[31].more[2]",
          "B ops[33].does",
          "B ops[49].more[1]",
          "B ops[58].does",
          "B ops[176].more[0]",
          "B ops[176].more[2]",
        ],
        "tires": [
          "pluginText.pf.license.check",
          "A ops[12].more[1]",
          "A ops[35].does",
          "A ops[105].more[1]",
          "B ops[75].does",
          "B ops[86].more[1]",
        ],
        "tours": [
          "A ops[15].why",
          "B ops[13].why",
        ],
        "towing": [
          "pluginText.pf.license.blocks going live",
        ],
        "trainer": [
          "pluginText.pf.license.certificates",
          "A ops[5].why",
          "B ops[5].why",
        ],
        "translator": [
          "A ops[4].why",
        ],
        "travel-agent": [
          "A ops[63].more[1]",
          "B ops[59].more[1]",
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
        "upholstery": [
          "B rename[82][1]",
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
          "A ops[2].does",
          "B ops[0].more[1]",
          "B ops[2].does",
          "B rename[56][1]",
        ],
        "window-tint": [
          "pluginText.pf.license.check",
        ],
        "windows": [
          "A ops[3].more[1]",
          "B ops[4].more[1]",
        ],
        "yoga": [
          "A ops[18].why",
          "A rename[340][1]",
          "A rename[428][1]",
          "B ops[13].why",
          "B rename[356][1]",
          "B rename[444][1]",
        ],
      }
    `);
  });

  it("leaves no text the compiled overlay holds saying Rosie checks a paper, no pf block waiting on a paper no one named checks, and marks each text it changed", () => {
    for (const id of ALL) {
      const { trade, done } = marked(id);
      for (const leaf of tradeTexts(done.trade)) {
        expect(findClaims(leaf.text), `${id} ${leaf.path}`).toStrictEqual([]);
        expect(
          findClaims(leaf.text, patternsAt(leaf.path), namedAt(leaf.path)),
          `${id} ${leaf.path}`,
        ).toStrictEqual([]);
      }
      for (const one of done.marked) {
        const patterns = patternsAt(one.where);
        expect(one.tag).toBe("MC:C7");
        // A marked text names a paper, in its words or by its place (namedAt, a rename's first side).
        expect(findClaims(one.before, patterns, true).length, `${id} ${one.where}`).toBeGreaterThan(0);
        expect(one.after, `${id} ${one.where}`).toContain(C7_MARKER);
        expect(one.after, `${id} ${one.where}`).toBe(ownWord(one.before, patterns, true));
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
        // Every text is read with WORD_PATTERNS but a message a person reads (patternsAt, DL-901); a pf block is stored
        // whole as one text (K-01 pluginText).
        expect(findClaims(leaf.text, patternsAt(leaf.path)), leaf.path).toStrictEqual([]);
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

describe("the security reviewer's round 3 FAIL and the lead's ruling on op text (DL-901 items 14 and 15)", () => {
  it("marks dance.json:8386, a claim after a negation across a separator, and snow.json:5512, a paper checked by no one named in an op's words", () => {
    const cases = [
      // dance.json:8386: the words op at S11-57, form[3][1] (the "Licenses" row). The "None" of "None needed" is its own
      // item's; after the "·", the registration was "checked on the state's lookup".
      {
        trade: "dance",
        at: "S11-57",
        line: "None needed · registration checked on the state's lookup, Oct 19",
        read: (op: TradeOp | undefined) => (op as { form?: string[][] } | undefined)?.form?.[3]?.[1],
        place: "form[3][1]",
      },
      // snow.json:5512: the words op at S2-21, the staff table's "Licenses" cell. A registration "checked", by no one named.
      {
        trade: "snow",
        at: "S2-21",
        line: "None needed · registration 0628841, checked",
        read: (op: TradeOp | undefined) =>
          (op as { table?: { rows?: string[][] } } | undefined)?.table?.rows?.[0]?.[3],
        place: "table.rows[0][3]",
      },
    ];
    for (const { trade, at, line, read, place } of cases) {
      const { trade: raw, done } = marked(trade);
      const places: string[] = [];
      for (const flow of FLOWS) {
        const k = raw.flows[flow].ops.findIndex(
          (op) => op.op === "words" && op.at === at && read(op) === line,
        );
        if (k < 0) continue;
        const where = `${flow} ops[${String(k)}].${place}`;
        places.push(where);
        const mark = done.marked.find((one) => one.where === where);
        expect(mark?.tag, where).toBe("MC:C7");
        expect(mark?.before, where).toBe(line);
        expect(mark?.after, where).toBe(`None needed · ${OWN_WORD}`);
        expect(read(done.trade.flows[flow].ops[k]), where).toBe(`None needed · ${OWN_WORD}`);
      }
      expect(places.length, trade).toBeGreaterThan(0);
    }
    // Any separator ends a negation's reach (DL-901): a "·", "•", "—", "–", "|", "/" or a line break, as a comma does;
    // a colon too, but where it opens a lone negation's list, whose items it governs.
    for (const text of [
      "None needed · registration checked on the state's lookup, Oct 19",
      "None needed • registration checked on the state's lookup",
      "None needed | registration checked on the state's lookup",
      "None needed — registration checked on the state's lookup",
      "None needed – registration checked on the state's lookup",
      "None needed / registration checked on the state's lookup",
      "None needed\nregistration checked on the state's lookup",
      "None needed · registration 0628841, checked",
      "Not back in 1 business day: a person on Rosie's team checks the state's records another way, and Sam is told.",
    ])
      expect(findClaims(text, WORD_PATTERNS), text).toHaveLength(1);
    for (const text of [
      "Never: call a license checked, or let it stand for control (S1-75).",
      "Never: let a license stand for control (S1-75), or say a license is checked.",
      "None needed",
    ])
      expect(findClaims(text, WORD_PATTERNS), text).toStrictEqual([]);
  });

  it("reads the paper a text's place names, a pf block's key or the first side a new side replaces, and a paper's renewal (DL-901)", () => {
    expect(namedAt("pluginText.pf.license.renewals")).toBe(true);
    expect(namedAt("pluginText.pf.staff.licenses")).toBe(true);
    expect(namedAt("pluginText.pf.first_steps.steps[1].result")).toBe(false);
    expect(namedAt("A ops[3].more[0]")).toBe(false);
    const renewals = "Checked on each end date; a lapse pauses that person's bookings, and Sam is told.";
    expect(findClaims(renewals, WORD_PATTERNS)).toStrictEqual([]);
    expect(ownWord(renewals, WORD_PATTERNS, true)).toBe(
      `${OWN_WORD} a lapse pauses that person's bookings, and Sam is told.`,
    );
    expect(ownWord("A renewal receipt counts while it's checked.", WORD_PATTERNS)).toBe(OWN_WORD);
    // A date the business gave is no paper ("each date", as "the date"): a background check's renewal date (dance.json).
    expect(
      findClaims(
        "Rosie checks each date again on the plug-in's schedule. Here, Quinn's background check passes its renewal date with no new date on file.",
        WORD_PATTERNS,
      ),
    ).toStrictEqual([]);
    const photo = "Sam sends a photo of it, and Rosie checks it again right away.";
    const receipt = "A renewal receipt counts while it's checked.";
    const cases: readonly (readonly [trade: string, where: string, before: string, after: string])[] = [
      ["dance", "A rename[292][1]", photo, OWN_WORD],
      ["dance", "B rename[349][1]", photo, OWN_WORD],
      ["yoga", "A rename[340][1]", photo, OWN_WORD],
      ["yoga", "B rename[356][1]", photo, OWN_WORD],
      ["mortgage", "A rename[84][1]", "Class teacher · checked", `Class teacher · ${OWN_WORD}`],
      ["mortgage", "B rename[128][1]", "Class teacher · checked", `Class teacher · ${OWN_WORD}`],
      [
        "private-investigator",
        "pluginText.pf.license.renewals",
        renewals,
        `${OWN_WORD} a lapse pauses that person's bookings, and Sam is told.`,
      ],
      [
        "property-manager",
        "pluginText.pf.license.renewals",
        "Checked on each renewal date from the state's form. A lapse pauses that person's bookings, and Sam is told.",
        `${OWN_WORD} A lapse pauses that person's bookings, and Sam is told.`,
      ],
      [
        "notary",
        "A ops[3].does",
        "The office goes live on a notary's own commission. Sam's commission was checked already, so nothing is asked again.",
        `The office goes live on a notary's own commission. ${OWN_WORD}`,
      ],
      ["daycare", "A ops[64].more[0]", receipt, OWN_WORD],
      ["daycare", "B ops[64].more[0]", receipt, OWN_WORD],
      ["sitter", "B ops[139].more[0]", receipt, OWN_WORD],
    ];
    for (const [trade, where, before, after] of cases)
      expect(
        marked(trade).done.marked.find((one) => one.where === where),
        `${trade} ${where}`,
      ).toStrictEqual({ tag: "MC:C7", trade, where, before, after });
    // The first side, the master's own line that names the license, stays as written.
    expect(marked("dance").done.trade.flows.A.rename[292]).toStrictEqual([
      "Sam sends a photo of the license, and Rosie checks it again right away.",
      OWN_WORD,
    ]);
    expect(marked("mortgage").done.trade.flows.A.rename[84]?.[0]).toBe("Electrical license JE30417");
  });
});

/**
 * The six texts of messages a person reads that wait on a permit that "checks out" (movers.json's junk hauling), each
 * by its place (the scan's places: a message's index in its list, then its element's), with its one reason: a step that
 * waits on a check, CQ-347's (the lead's ruling at the pause, DL-904; item 15's last clause). They stay as written: a
 * message a person reads is read with CLAIM_PATTERNS alone (patternsAt), since OWN_WORD is no word for a person and
 * marking them would stop the build (C7ClaimError), which no rule here loosens.
 */
const WAITS_ON_A_CHECK = "a step that waits on a check: CQ-347's (DL-904)";
const MESSAGES_WAITING: readonly (readonly [place: string, reason: string])[] = [
  ["movers A.ops[11].say[2][2]", WAITS_ON_A_CHECK],
  ["movers A.ops[13].say[0][3].list.rows[1][1]", WAITS_ON_A_CHECK],
  ["movers A.ops[24].say[3][2]", WAITS_ON_A_CHECK],
  ["movers B.ops[11].say[2][2]", WAITS_ON_A_CHECK],
  ["movers B.ops[13].say[0][3].list.rows[1][1]", WAITS_ON_A_CHECK],
  ["movers B.ops[24].say[3][2]", WAITS_ON_A_CHECK],
];

/**
 * A text of a message a person reads that shows a paper as checked by no one named, and waits on nothing: a NEED for
 * the lead (DL-901 item 15, DL-904 item 19). notary.json's S1-23 card tells the owner the notary's commission is
 * "checked" ("Sam Lee · NP045210 · checked"); marking it would stop the build (C7ClaimError), which is never loosened,
 * so it stays as written until the lead rules. The same op's own words ("Sam's commission was checked already") are
 * marked.
 */
const MESSAGES_NEED: readonly (readonly [place: string, reason: string])[] = [
  [
    "notary A.ops[3].say[0][3].card.lines[0]",
    "NEED: a message a person reads shows a paper checked by no one named (DL-901 item 15)",
  ],
];

/**
 * The exhaustive scan's allow list (DL-901 item 16): every sentence of a compiled trade text (pf blocks, ops, renames'
 * and swaps' new sides, slot rows, money; messages too) that still holds a hit, with its one reason. A hit is a phrase
 * of SHAPES (CLAIM_PATTERNS and PASSIVE_PATTERNS without their guards), or a check verb with a negation within 3 words
 * before it across a separator (CHECK_VERB; one with the negation in its own clause is a true negation of it, and is not
 * listed). The reasons: a true negation ("checks none", "never checked"); no paper, with what is checked instead (a
 * fraud or booking-cap flag, a background check, a record on file, an identity, a vehicle, and the rest of default 4 and
 * the lead's rulings on round 3's open questions, DL-901 item 17); and lead note 12's S1-33 line in Rosie's own voice,
 * on C4's verify-only branch. A rename's or a swap's first side (the master's own line, default 4) is listed apart, in
 * FIRST_SIDES; the six messages that wait, in MESSAGES_WAITING.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "true negation": [
    "'Insured' is shown as given by the business, not checked by Rosie.",
    "'Insured' or 'bonded' is shown as given by the business, not checked by Rosie.",
    "'board-certified' is shown as given by the business, not checked by Rosie",
    "A background check shows as the business's word, never as checked by Rosie.",
    "A commission shows as the business gave it, never as 'checked by Rosie'.",
    "A credential shows as the business gave it, never as 'checked by Rosie'.",
    "A license or a registration shows as the business gave it, never as 'checked by Rosie'.",
    "A license or permit shows as the business gave it, never as 'checked by Rosie'.",
    "A license or registration shows as the business gave it, never as 'checked by Rosie'.",
    "A license shows as the business gave it, never as 'checked by Rosie'.",
    "A license shows on the listing only as the business gave it, never as checked by Rosie.",
    "A planning certificate (like CFP) is shown as a certificate, as given, not checked by Rosie, never as a license or registration.",
    "A registration shows as the business gave it, never as 'checked by Rosie'.",
    "Any arborist certificate the business wants shown (it shown as given by the business, not checked by Rosie)",
    "As given by the business, not checked by Rosie",
    "Boarding license, as given by the business, not checked by Rosie",
    "Child care center EX-2098, as given by the business, not checked by Rosie",
    "Commercial vehicle insurance and pet-care liability insurance are shown as given by the business, not checked by Rosie.",
    "D96: Rosie checks no license before anyone is offered",
    "D96: Rosie looks no license up;",
    "D96: licenses are never re-checked by Rosie",
    "D96: licenses are optional and never looked up by Rosie: no lookup branch",
    "D96: no claim is shown as checked",
    "D96: no license is checked by Rosie for this work;",
    "D96: no license is re-checked when its holder leaves",
    "D96: nothing is looked up, so no license is re-checked when its holder leaves;",
    "EX-1042, as given by the business, not checked by Rosie",
    "Each architect's own license, and the firm's registration where the state asks: the owner's own papers, shown as given, never checked by Rosie (D96).",
    "Each loan officer: their own license for each state they take calls for (optional, shown as given, not checked by Rosie).",
    "Every license, permit or certificate is the owner's word: Rosie checks none of them.",
    "Food service permit, as given by the business, not checked by Rosie",
    "For golf lessons none runs: no person license is checked.",
    "For ski lessons none runs: no person license is checked.",
    "For sports coaching none runs: no person license is checked.",
    "For this work none runs: no person license is checked.",
    "General liability insurance is shown as given by the business, not checked by Rosie.",
    "Golf lessons need no license checked here.",
    "Golf lessons need no state license checked here, so nothing is looked up.",
    "Insured is shown as given by the business, not checked by Rosie.",
    "Insured or bonded is shown as given by the business, not checked by Rosie.",
    "It is shown as given by the business, not checked by Rosie.",
    "It shows as given by the business, not checked by Rosie.",
    "It shows as the business's word, never as checked by Rosie.",
    "It shows in the business's own words, never as checked by Rosie.",
    "It's optional and shown as given, not checked by Rosie.",
    "Kennel license, as given by the business, not checked by Rosie",
    "Liability insurance and a bond are shown as given by the business, not checked by Rosie.",
    "Liability insurance is shown as given by the business, not checked by Rosie.",
    "Liability insurance or a bond is shown as given by the business, not checked by Rosie.",
    "Liability insurance that covers horses in the farrier's care is shown as given by the business, not checked by Rosie.",
    "Licenses are the owner's own word: Rosie looks no license up, and every service is kept to the owner's words.",
    "Martial arts and personal training license nobody here, so no person's license is checked.",
    "Never checked by Rosie (D96): each registration is as the firm gives it.",
    "Never: call a license checked, or let it stand for control (S1-75).",
    "Never: let a license stand for control (S1-75), or say a license is checked.",
    "No license is checked, so nothing waits on one.",
    "No license lookup (D96): each captain's and the boat's papers are the owner's own, never checked by Rosie.",
    "No license lookup (D96): the guide's and the hunter's papers are their own, never checked by Rosie.",
    "No license lookup (D96): the owner's own permits, never checked by Rosie.",
    "No license lookup for a course (D96): the owner's own papers, never checked by Rosie.",
    "No license lookup for a park (D96): the owner's own papers, never checked by Rosie.",
    "No license lookup for a venue (D96): the owner's own papers, never checked by Rosie.",
    "No license lookup for an appraiser (D96): the owner's own papers, never checked by Rosie.",
    "No license lookup for an architect (D96): the owner's own papers, never checked by Rosie.",
    "No license shows as checked: the owner's word is the only record.",
    "No person license is checked for this work (D96): a certificate is the person's own word, optional.",
    "No person license is checked for this work (D96): the coach's certificate is the business's word.",
    "Nobody is shown as checked, and customers see no license claim for that person.",
    "None is checked by Rosie.",
    "Not checked by Rosie, for the hunter or the guide.",
    "Not checked by Rosie.",
    "Nothing is checked by Rosie.",
    "Nothing is shown as checked;",
    "On file as given, not checked by Rosie.",
    "Optional, and Rosie checks nothing.",
    "Pet-care insurance or a bond is shown as given by the business, not checked by Rosie.",
    "Pet-care liability insurance or a bond is shown as given by the business, not checked by Rosie.",
    "Rosie checks no card, license or approval: each one is the business's own word, shown as that, never as a state license or as checked",
    "Rosie checks no card, license or permit: each one is the business's own word, shown as that, never as a state license or as checked",
    "Rosie checks no certificate, license or permit: each one is the business's own word, shown as that, never as a state license or as checked",
    "Rosie checks no check or certificate;",
    "Rosie checks no license again: the owner's word stands.",
    "Rosie checks no license or check;",
    "Rosie checks no license, certificate or background check: each one is the business's own word, shown as that, never as a state license or as checked",
    "Rosie checks no license, certificate, insurance or background check",
    "Rosie checks no license, permit or carrier number: each one is the business's own word, shown as that, never as a state license or as checked",
    "Rosie checks no license.",
    "Rosie checks no license;",
    "Rosie checks no licenses.",
    "Rosie checks no papers;",
    "Rosie checks none of it and never says it was checked.",
    "Rosie checks nothing)",
    "Rosie does not check, look up or verify any license, credential or insurance (D96).",
    "Rosie does not check, look up or verify any license, credential, insurance or vet letter (D96).",
    "Rosie does not check, look up or verify any license, registration or credential (D96).",
    "Rosie does not check, look up or verify any license, registration, certificate or credential (D96).",
    "Rosie does not look up, check or verify a license number.",
    "Rosie does not look up, check or verify any license, certificate or registration (D96).",
    "Rosie does not look up, check or verify any license, registration or certificate (D96).",
    "Rosie looks no license up and checks none.",
    "Rosie looks nothing up and checks nothing.",
    "Rosie looks nothing up and never says anything is checked",
    "Rosie looks nothing up, so no screenshot is kept.",
    "Rosie looks nothing up.",
    "Rosie looks up no licenses or checks (D96): a lapsed check is never raised for band work.",
    "Rosie looks up no licenses or checks (D96): a lapsed check is never raised for character work.",
    "Rosie looks up no licenses or checks (D96): a lapsed check is never raised for clown work.",
    "Rosie looks up no licenses or checks (D96): a lapsed check is never raised for comedy work.",
    "Rosie looks up no licenses or checks (D96): nothing to re-check for band work.",
    "Rosie looks up no licenses or checks (D96): nothing to re-check for character work.",
    "Rosie looks up no licenses or checks (D96): nothing to re-check for clown work.",
    "Rosie looks up no licenses or checks (D96): nothing to re-check for comedy work.",
    "Rosie never prices, confirms or moves it",
    "Rosie never says a certificate was checked by Rosie",
    "Rosie never says a certification was checked by Rosie",
    "Rosie never says a license was checked by Rosie",
    "Safe default: no person license is checked here.",
    "Sam sends a photo of the license, and it is shown as given, not checked by Rosie.",
    "Shown as given by the business, not checked by Rosie.",
    "Sitting, tutoring and play room work license nobody where Sam works, so no license is checked.",
    "Ski lessons need no license checked here.",
    "Ski lessons need no state license checked here, so nothing is looked up.",
    "Sports coaching need no license checked here.",
    "Sports coaching need no state license checked here, so nothing is looked up.",
    "Staff hold no license Rosie checks.",
    "The business's own word, never checked by Rosie.",
    "The flight school needs no state license checked here, so nothing is looked up.",
    "The owner's own word decides, and Rosie looks nothing up.",
    "The practice's own word, not checked by Rosie.",
    "The range needs no state license checked here, so nothing is looked up.",
    "The stable needs no state license checked here, so nothing is looked up.",
    "The studio needs no state license checked here, so nothing is looked up.",
    "The studio's business license is optional and shown as given by the business, not checked by Rosie.",
    "The studio's own registration is optional and shown as given by the business, not checked by Rosie.",
    "The studio's registration is optional and shown as given by the business, not checked by Rosie.",
    "They are shown as given by the business, not checked by Rosie.",
    "Where a state or city asks for an appraiser's registration or certificate, or the business's own, the owner names it: shown as given, never checked by Rosie.",
    "Where a state or city licenses detailing or mobile washing, its form asks for it (optional, shown as given, not checked by Rosie).",
    "Where the city requires a park permit for group walks, Rosie checks no permit;",
    "Where the state or a city asks for a crematory permit or the business registration, the owner names it: shown as given, never checked by Rosie.",
    "Where the state's form also licenses each installer or salesperson, each one may add a number (optional, shown as given, not checked by Rosie).",
    "Where the state's form also licenses each person, each one may add a number (optional, shown as given, not checked by Rosie).",
    "Where the state's form requires a business registration, Rosie checks no registration;",
    "Why: Rosie looks no license up.",
    "a driver's commercial license with a passenger endorsement and a current medical card for larger vans: the business's own word, never checked by Rosie",
    "a switch from the state's form: where the state requires background checks for adults who work with children, each instructor's check is asked for (who ran it, and the date) and shown as the school's word, never as checked by Rosie",
    "a switch from the state's form: where the state requires background checks for adults who work with children, each teacher's check is asked for (who ran it, and the date) and shown as the center's word, never as checked by Rosie",
    "a trainer's certificate (like CPDT-KA) is the trainer's own claim: shown as 'certified' only as the trainer states it, not checked by Rosie, and taken off when it lapses",
    "any background check for coaches of children is the business's own policy, not checked by Rosie",
    "any background check is the business's own policy, not checked by Rosie",
    "any teacher's background check is the owner's word (optional, never checked by Rosie);",
    "anything shown is as given by the business, not checked by Rosie",
    "background checks for people who work with children: the owner's word, optional, never checked by Rosie",
    "each acupuncturist's national board certificate kept on file as the business's own word, never shown as checked (Rosie's rule)",
    "each clinician's own license or registration, if the business adds one (optional, not checked by Rosie)",
    "each coach's certificate and first-aid card: the business's own word, never checked by Rosie",
    "each instructor's card for the courses taught, under a program or training center: the business's own word, never checked by Rosie",
    "each instructor's lifeguard or first-aid card, the business's own word, never checked by Rosie",
    "each teacher's certificate or background check, the business's own word, never checked by Rosie",
    "food safety: any food-handler card the owner adds is the owner's word, optional, never checked by Rosie",
    "malpractice insurance: the owner's word, never checked by Rosie",
    "never checked by Rosie (D96)",
    "never checked by Rosie)",
    "never checked by Rosie",
    "never looked up by Rosie",
    "no engineer license is checked (D96);",
    "no license is checked for this work (D96)",
    "no person license is checked for coaching;",
    "no person license is checked for golf lessons;",
    "no person license is checked for ski lessons;",
    "no person license is checked unless the state form asks.",
    "none checked by Rosie: a flight school needs no state license in most places;",
    "none checked by Rosie: a non-dental studio whitens teeth as a cosmetic service;",
    "none checked by Rosie: a range needs no state license in most places;",
    "none checked by Rosie: a recording studio needs no state license in most places;",
    "none checked by Rosie: golf lessons need no state license here;",
    "none checked by Rosie: hypnotherapy has no state license in most places;",
    "none checked by Rosie: no state license to teach riding in most places;",
    "none checked by Rosie: private coaching needs no state license here;",
    "none checked by Rosie: reiki has no state license in most places;",
    "none checked by Rosie: ski and snowboard lessons need no state license here;",
    "none checked by Rosie: spray tanning has no state license in most places;",
    "none is checked by Rosie, D96)",
    "none: Rosie does not look up, check or confirm any license, registration, certificate or insurance (D96);",
    "none: Rosie looks no license up and checks none (D96);",
    "none: Rosie never looks up, checks or confirms a credential, license, insurance or registration (D96);",
    "none: Rosie never looks up, checks or confirms a license, certificate, roster listing or insurance (D96);",
    "none: Rosie never looks up, checks or confirms a license, insurance or permit (D96);",
    "none: Rosie never looks up, checks or confirms a license, insurance or registration (D96);",
    "none: Rosie never looks up, checks or confirms a license, permit or registration (D96);",
    "none: Rosie never looks up, checks or confirms a license, registration, accreditation or bond (D96);",
    "none: Rosie never looks up, verifies or tracks a license, insurance or registration (D96)",
    "not checked by Rosie (D96)",
    "optional, and never verified by Rosie: a consultant may add a lactation certification it holds (IBCLC or similar), and the business may add a registration;",
    "optional, and never verified by Rosie: a doula may add a certification or training certificate it holds;",
    "optional, and never verified by Rosie: a midwife, a birth assistant or the practice may add a license, certificate or registration it holds;",
    "shown as given by the business, not checked by Rosie",
    "shown as given, not checked by Rosie).",
    "shown as the owner's word, never checked by Rosie",
    "switch: a leased or financed vehicle needs the lessor's OK where the lease says so: asked, never checked by Rosie",
    "the center keeps its own record (optional, never looked up by Rosie)",
    "the clinic keeps its own record (optional, never looked up by Rosie)",
    "the nurse's own training is the business's word, not checked by Rosie",
    "the owner's word, never looked up by Rosie",
    "the photo's number and name, as given, not checked by Rosie",
    "the practice keeps its own record (optional, never looked up by Rosie)",
  ],
  // dj.json S12-19 (the lead's ruling on round 3's open question 1, DL-901 item 17): a background check is no paper in
  // MC C7's list.
  "no paper: a background check": [
    "Background checks are asked instead (S2-29).",
    "Rosie checks again what the plug-in names, on its schedule.",
    "Rosie checks what the plug-in names on the state's own service.",
  ],
  // chef.json B ops[39]'s food handler card (item 17's open question 2): a record on file, not a lookup.
  "no paper: a record on file": [
    "A damage claim or a later complaint is checked against the before record.",
    "Rosie first checks that Ines is free and has a food handler card.",
    "Sam checks the before photos on the call, and a refund goes through the portal.",
  ],
  // A person's own identity papers (default 4): a learner's permit the instructor checks in person, a driver's license,
  // proof of citizenship the school checks ("checked by the school before the first flight", flight-school.json).
  "no paper: an identity": [
    "Does Alex's learner's permit check out?",
    "Does Lily's learner's permit check out?",
    "Driver's license checked",
    "Drivers give none: their driver's license is checked by the business.",
    "checked: training goes on;",
  ],
  // A patient's own coverage, which the front desk or the pharmacy checks by hand (the checker named in the same text).
  "no paper: a customer's coverage, checked by the business": [
    "checked again a few days before the visit",
    "checked again the working day before",
  ],
  "no paper: an item, a vehicle or equipment": [
    "Before anything is taken, Rosie checks each window against the darkness limit the shop's state form sets for that window.",
    "Checked at booking and again on site.",
    "Checked on every first visit.",
    "checked on site, and the line comes off if it isn't needed",
    "the hull ID and the engine's serial number are checked for open safety recalls at check-in;",
  ],
  "no paper: a fraud or booking-cap flag": [
    "It never accuses anyone: it tells Sam, and a person on Rosie's team checks.",
    "Sam sees the flag, and a person on Rosie's team checks it within 1 business day.",
  ],
  // The plug-in's rule on where work away from the shop is allowed and who may go, or on a job's first steps; Rosie
  // checks the rule, not a paper (round 1's security item 7: funeral.json, tattoo.json).
  "no paper: a plug-in rule": [
    "Rosie checks before any visit away from the office is offered.",
    "Rosie checks before any visit away from the pharmacy is offered.",
    "Rosie checks before the secure link, so the page knows what to ask.",
    "Rosie checks before the secure link.",
    "Rosie checks it before any service is set at a customer's place.",
    "Rosie checks that before 'yard to your door' is offered.",
    "Rosie checks that before a delivery is offered.",
    "Rosie checks that before a home meeting is offered.",
    "Rosie checks that before a home overnight is offered.",
    "Rosie checks that before a home plan review is offered.",
    "Rosie checks that before a review at the house is offered.",
    "Rosie checks that before play at home is offered.",
    "Rosie checks that before the mobile visit is offered.",
    "Rosie checks this before the secure link, so the page knows what to ask.",
    "Rosie checks this before the secure page, so the page knows what to ask.",
  ],
  "no paper: a calendar or a time": [
    "Google: Rosie reads when I'm busy, never what it is",
    "Rosie checks Carl's calendar once more, then saves the tour.",
    "Rosie checks Omar's calendar once more, then saves the tour.",
    "Rosie checks again before it writes the booking.",
    "Rosie checks both teachers' calendars once more, then saves the booking.",
    "Rosie checks for a trial spot first.",
    "Rosie checks he's free first.",
    "Rosie checks once more that Kyle is free, then saves the booking.",
    "Rosie checks that Hannah has the time, then shows the new price first.",
    "Rosie checks that Helen has the time, and Helen is told.",
    "Rosie checks that Kevin has the time, then shows the price first.",
    "Rosie checks that Maya has the time and sends the video link.",
    "Rosie checks the Lodge has time for it, then shows the price first.",
    "Rosie checks the calendars and the vaccine count once more, then saves the booking.",
    "Rosie checks the calendars once more, then saves the booking.",
    "Rosie checks the day and asks Sam.",
    "Rosie checks the day, finds the bookings it touches, and pauses new ones for Ruth that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Dina that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Gina that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Gus that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Leah that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Lia that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Priya that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Simon that day.",
    "Rosie checks the day, finds the visits it touches, and pauses new ones for Tomas that day.",
    "Rosie checks the room has a 3-day place, then shows the new price first.",
    "Rosie checks the room once more, then saves the booking.",
    "Rosie checks the session has room for an extra hour, then shows the price first.",
    "Rosie checks there's a space for each dog every night.",
    "Rosie checks there's room in the slot, then shows the price first.",
  ],
  "no paper: a place or an address": [
    "About how big is the lawn: up to 1/4 acre, up to 1/2 acre, or bigger (or Rosie reads the county's lot record from the address)",
    "Rosie checks both: inside Sam's 25 miles, and in a state whose form the business filled in.",
    "Rosie checks it again: a home on Sam's list, with Alex on its resident list.",
    "Rosie checks it again: inside Sam's 10 miles, and in a state whose form the business filled in.",
    "Rosie checks it again: inside Sam's 25 miles, and in a state whose form the business filled in.",
    "Rosie checks it again: inside Sam's 25 miles, and in a state whose form the school filled in.",
    "Rosie checks the business manages homes there;",
    "Rosie checks the pickup is inside Sam's 25 miles, and the move inside its 300.",
    "Rosie checks the street address before Alex's yes.",
    "So the AI asks the town first, and Rosie checks the business manages homes there, before any times.",
    "The price comes from the lawn's size: Alex's answer, checked against the county's lot record.",
  ],
  // A price, a fee or a job against the limit the business's license sets (default 4: a job against a license, S13-15).
  "no paper: a price, a fee or a job size": [
    "Next, Sam picks which prices Rosie checks with Sam first.",
    "Next, Sam picks which prices Rosie checks with him first.",
    "Next, Sam picks which prices Rosie checks with him first: anything over $500.",
    "Rosie checks each price against the cap at sign-up and at DONE.",
    "Rosie then checks each job's total against it.",
    "Sam confirms each fee, never more than what was paid now or agreed;",
    "The $89 dry-run fee is kept only for a late cancel or a no-show, if Sam confirms it.",
    "The late-cancel fee is kept only for a late cancel or a no-show, as Sam confirms it.",
    "Where a license is needed only above a job-size amount, Rosie checks each job's total, an add-on too, against it.",
    "Where the form licenses work only above a job size, Rosie checks each job against it: at booking, when a task is added by text, and at the visit.",
    "Where the state's form licenses handyman work only up to a job size, Rosie adds up the tasks and checks the total.",
    "the owner confirms every fee",
  ],
  "no paper: words read back": [
    "Alex didn't book a bath, so Rosie reads the price back, then asks Alex first.",
    "Alex didn't book it, so Rosie reads it back, then asks Alex first.",
    "Alex didn't book it, so Rosie reads the price back, then asks Alex first by text.",
    "Alex didn't book that time, so Rosie reads it back, then asks Alex first.",
    "Alex didn't book that work, so Rosie reads the quote back, then asks Alex first.",
    "Alex didn't book that, so Rosie reads the extra back, then asks Alex first.",
    "Alex didn't book that, so Rosie reads the price back and asks Alex first.",
    "Alex didn't book that, so Rosie reads the price back, then asks Alex first.",
    "Derek texts the total, and Rosie reads it back.",
    "Derek texts what's due, and Rosie reads it back.",
    "Nadia texts DONE with the total and its lines, and Rosie reads it back.",
    "Rosie reads Daniel's DONE back.",
    "Rosie reads Gabe's DONE back.",
    "Rosie reads Gil's DONE back.",
    "Rosie reads Hana's DONE back: 4 hours, 2 teachers, $320, straight from the price list.",
    "Rosie reads Henry's DONE back.",
    "Rosie reads Marco's DONE back.",
    "Rosie reads Mateo's DONE back.",
    "Rosie reads Nadia's DONE back.",
    "Rosie reads Rory's DONE back.",
    "Rosie reads Sam's list of calls and meetings and fills the plug-in's list of services.",
    "Rosie reads Sam's list of services and fills the plug-in's list.",
    "Rosie reads Sam's price list and fills the plug-in's list of items.",
    "Rosie reads Sam's price list and fills the plug-in's list of services.",
    "Rosie reads Sanjay's DONE back.",
    "Rosie reads Taylor's DONE back: 6:00 to 10:30pm is 4½ hours at $24, so $108.",
    "Rosie reads Tomás's DONE back.",
    "Rosie reads Tyler's DONE back.",
    "Rosie reads Victor's DONE back.",
    "Rosie reads it back before any family is texted.",
    "Rosie reads it back before it goes out.",
    "Rosie reads it back first.",
    "Rosie reads it back, and nothing goes to Alex until Sam says send it.",
    "Rosie reads it back, then asks Alex first.",
    "Rosie reads it back, then asks Alex.",
    "Rosie reads it back, then offers it to Alex.",
    "Rosie reads it back, then texts the customer the bill with a pay link.",
    "Rosie reads the build date from the label.",
    "Rosie reads the prices straight from the funeral home's price list, to anyone who asks, before any booking.",
    "Rosie reads them back, and Sam is told.",
    "Sam sends a photo of the center's rooms, and Rosie reads it back.",
    "Sam sends a photo of the classroom schedule, and Rosie reads it back.",
    "Sam sends a photo of the club's session schedule, and Rosie reads it back.",
    "Sam sends the open house schedule, and Rosie reads it back.",
    "The extra hour is $80, so Rosie reads the price back, then asks Alex first.",
    "The owner sends a photo of the express timetable, and Rosie reads it back.",
    "The owner sends a photo of the shuttle timetable, and Rosie reads it back.",
    "They weren't in the price, so Rosie reads the price back, then asks Alex first.",
  ],
  "no paper: the weather": [
    "At 5pm the day before, Rosie checks the public forecast for each outdoor booking.",
    "At 5pm the day before, Rosie checks the public forecast for each outdoor event.",
    "At 5pm the day before, Rosie checks the public forecast for each outdoor lesson.",
    "At 5pm the day before, Rosie checks the public forecast for each outdoor session.",
    "Rosie checks the forecast the day before;",
    "Weather over the limit the day before: Rosie checks the forecast for each outside job;",
  ],
  // A date the business gave, or a report that is due (dance.json's is a background check's renewal date).
  "no paper: a date or a report": [
    "On that day, Rosie checks it's ready.",
    "On that day, Rosie checks they're ready.",
    "Rosie checks each date again on the plug-in's schedule.",
    "Rosie checks the date, and the desk texts READY.",
  ],
  "no paper: a danger": [
    "Don't turn the pump on until it's checked.",
    "Keep people off that part and away from the railing until it's checked.",
    "Rosie checks it for danger, then sends the plug-in's steps: keep it shut, no fire, and a wildlife company first.",
    "Rosie checks it for danger, then sends the plug-in's steps: keep the area shut, and a wildlife company first.",
  ],
  "no paper: a check-in": [
    "A wedding has no no-show: the planners check in with the couple or a named adult, or Julian texts DONE at the end.",
    "Alex gives the code at the front door, and Carl's phone enters it, so Alex is checked in.",
    "Alex gives the code at the front door, and Omar's phone enters it, so Alex is checked in.",
    "Daniel's phone enters it, so Alex is checked in.",
    "Ethan's phone enters it, so Alex is checked in, and the visit counts for Rosfield's $2.",
    "Ethan's phone enters it, so Alex is checked in.",
    "Hector's phone enters the code at 7:28pm, so Alex is checked in.",
    "Henry's phone enters the code, so Alex is checked in.",
    "Leo's phone enters the code, so Alex is checked in.",
    "Luis's phone enters the code, so Alex is checked in.",
    "Marcus's phone enters it, so Alex is checked in.",
    "Marcus's phone enters the code, so Alex is checked in.",
    "Marisol checks Juniper in by hand.",
    "Nico's phone enters the code, so Juniper is checked in for her stay.",
    "Taylor's phone enters the code, so Alex is checked in.",
  ],
  "no paper: a question for a person": [
    "Check it with A.M.",
    "Next, Rosie checks for a request only a person may decide.",
    "Please check with Carl.",
    "Please check with Marcus.",
    "Please check with Omar.",
    "Please check with Taylor and send the total.",
    "Please check with Taylor.",
  ],
  "no paper: a job or a body": [
    "Dale re-checks the size of every opening.",
    "Dante checks it at the visit too.",
    "No, just a check-up.",
    "Not done: that check",
    "Not done: the check of that area",
    "checked from photos",
    "none: a braces check or a fitting needs the chair;",
    "the crew fixes it at no cost, the re-check is booked, and the next stage and its bill wait",
  ],
  // Lead note 12 (DL-894): S1-33's line in Rosie's own voice sits on C4's verify-only branch, off while verify is off;
  // C4 and T-147's markers cover it, and C7 leaves it as written (farrier.json:1447, the round 3 reviewer's item 8).
  "lead note 12: S1-33's line, on C4's verify-only branch": [
    "We couldn't find business registration EX-1042 for Sam Lee on the official lookup.",
  ],
};

/** The hits on a rename's or a swap's first side: the master's own line it matches, never changed (default 4). */
const FIRST_SIDES: readonly string[] = [
  "A license holder confirms it on their own secure page when they join, or Rosie's team checks.",
  "A license shows as 'checked by Rosie' only after Rosie read it on the state's lookup, with the date.",
  "AI assistants can book it once your electrician's own license checks out.",
  "Addresses there are offered once a license checks out, and only for the people it covers.",
  "Alex didn't book that work, so Rosie reads the quote back, then asks Alex first.",
  "At 5pm the day before, Rosie checks the public forecast for each outdoor job.",
  "Avery's license is checked again when the lookup answers.",
  "Avery's license shows as expired on the official lookup.",
  "Casey's license is checked again when the lookup answers.",
  "Casey's license shows as expired on the official lookup.",
  "Checked by Rosie on the state's lookup, Oct 19",
  "Checked by Rosie's team",
  "Checked on the official lookup",
  "Customers can book it once a barber's own license checks out.",
  "Customers see the shop once a barber's license checks out and Sam says yes.",
  "Customers see the studio once a teacher's license checks out and Sam says yes.",
  "Dev's license is checked again when the lookup answers.",
  "Each is checked on the lookup the plug-in names.",
  "Each license is checked the moment it's added on the secure page, after the person's YES.",
  "Each person is offered once their own license checks out and the owner says yes.",
  "Eli's license checked out on the second state's lookup.",
  "Every license, permit or certificate the work needs is checked on the official lookup the plug-in names.",
  "Everyone's licenses are confirmed on the official lookup.",
  "Felix's license is checked again when the lookup answers.",
  "It goes live on its own once its licenses check out.",
  "It goes live once Jordan's own license checks out",
  "It goes live once its licenses check out.",
  "It's checked on the official lookup the plug-in names.",
  "It's re-checked like a license: S13-41.",
  "Its license checked out.",
  "Jordan's license checked out on the second state's lookup.",
  "Leo's license checked out on the second state's lookup.",
  "Licenses are checked again every 30 days, before each end date, and the day the license holder leaves or the owner changes.",
  "Licenses: Checked by Rosie on the state's lookup, Oct 19",
  "Luis's license checked out on the second state's lookup.",
  "Marcus's license checked out on the second state's lookup.",
  "Milo's license is checked again",
  "New bookings for it pause until the license checks out again.",
  "Nobody is offered to customers until their license is confirmed and Sam says yes.",
  "On that day, Rosie checks it's ready.",
  "Once Jordan's license checks out and you say yes",
  "Once your electrician's license checks out and you say yes",
  "Quinn can be booked once the license checks out on the state's lookup, and Sam says yes.",
  "Ravi's license is checked again when the lookup answers.",
  "Reese can be booked once the license checks out on the state's lookup, and Sam says yes.",
  "Rosie checks each license again on the state's lookup: every 30 days by default, and before each end date.",
  "Rosie checks that Riley has the time, then shows the price first.",
  "Rosie checks that before the house call is offered.",
  "Rosie checks the name, kind, status, services, places and end date.",
  "Rosie reads it back first.",
  "Rosie reads it back, then asks Alex.",
  "Rosie's rule: a claim shows as checked only when it was.",
  "Rosie's team checks the official lookup within 1 business day.",
  "Rosie's team confirms within 1 business day.",
  "Sam gives the shop's number, and Rosie checks it on the state's lookup.",
  "Sam sends a photo of the license, and Rosie checks it again right away.",
  "Sam sends a photo of the license, and it is shown as given, not checked by Rosie.",
  "Sam's own license was checked at sign-up.",
  "That day, the license is checked again on the lookup the plug-in names.",
  "The license is checked again that day.",
  "The licenses check out;",
  "The owner sends a photo of the class schedule, and Rosie reads it back.",
  "The shop's own license is checked first.",
  "The studio's own license is checked first.",
  "Where a lookup has no data feed, a person on Rosie's team checks the official site and keeps a screenshot.",
  "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day.",
  "You follow your state's rules for your trade, and Rosie checks licenses itself.",
  "Your license shows as expired on the official lookup, so Lee Home Services can't book you until it shows renewed.",
  "Your license shows as expired on the official lookup, so Lee's Barbershop can't book you until it shows renewed.",
  "Your license, checked while you go on",
  "checked from photos",
  "license checked out on the second state's lookup.",
  "licenses only as checked,",
];

/** A negation word, as c7.ts reads one. */
const NEGATION_WORD = /\b(?:never|not|no|nor|cannot|nothing|none|nobody)\b|n't\b/i;

/** A clause break: any separator (DL-901). */
const BREAK = /[,;:.!?](?=\s|$)|[·•—–|/\n]/;

/** A text's words: each run with a letter (punctuation alone is no word). */
function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => /[a-z]/i.test(word));
}

/** Whether a negation lies within 3 words before the end of a text. */
function negationBefore(text: string): boolean {
  return words(text)
    .slice(-3)
    .some((word) => NEGATION_WORD.test(word));
}

/**
 * A text's sentences, each with where it starts: a sentence ends at ".", ";", "!" or "?" before white space, at a "·",
 * "•" or "|" between spaces, or at a line break.
 */
function sentencesOf(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const end of text.matchAll(/(?<=[.;!?])\s+|\s+[·•|]\s+|\s*\n\s*/g)) {
    out.push({ text: text.slice(start, end.index), start });
    start = end.index + end[0].length;
  }
  out.push({ text: text.slice(start), start });
  return out;
}

/** Whether a negation lies within 3 words before `at` in a sentence, in its own clause (after its last clause break). */
function negatedInClause(sentence: string, at: number): boolean {
  return negationBefore(sentence.slice(0, at).split(BREAK).pop() ?? "");
}

const WHO = String.raw`(?:a person on Rosie's team|Rosie's team|Rosie)`;

/**
 * The scan's shapes (DL-901 item 16): CLAIM_PATTERNS and PASSIVE_PATTERNS without the guards that keep a check of no
 * paper (NO_PAPER), a learner's permit, a driver's license or a named checker out, so the scan lists those too. The
 * first two are CLAIM_PATTERNS' first two as written, but for those guards.
 */
const SHAPES: readonly { pattern: RegExp; passive: boolean }[] = [
  {
    pattern: new RegExp(
      String.raw`\b${WHO}\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|looks\s+(?:[\w'-]+\s+){0,4}?up|has\s+read|reads|verifies|confirms)\b`,
      "g",
    ),
    passive: false,
  },
  { pattern: /\bRosie\s+[a-z]+s\b[^.;:]{0,80}?\band\s+(?:re-?)?checks\b/g, passive: false },
  ...CLAIM_PATTERNS.slice(2).map(({ pattern }) => ({
    pattern: new RegExp(pattern.source, `${pattern.flags}g`),
    passive: false,
  })),
  ...PASSIVE_PATTERNS.map(({ pattern }) => ({
    pattern: new RegExp(
      pattern.source.replace(/\(\?<!(?:learner|driver)'s\\s\)|\(\?!\\s\+by\\b\)/g, ""),
      `${pattern.flags}g`,
    ),
    passive: true,
  })),
];

/** A check verb in any words: a hit where a negation within 3 words before it lies across a clause break. */
const CHECK_VERB =
  /\b(?:re-?)?(?:check(?:s|ed)?|verif(?:y|ies|ied)|confirm(?:s|ed)?)\b|\blook(?:s|ed)?\s+(?:[\w'-]+\s+){0,4}?up\b/gi;

/** One text of a trade, at its place: on a rename's or a swap's first side, or in a message a person reads. */
interface Leaf {
  where: string;
  text: string;
  first: boolean;
  message: boolean;
}

function leavesOf(value: unknown, where: string, out: Leaf[], first = false, message = false): Leaf[] {
  if (typeof value === "string") out.push({ where, text: value, first, message });
  else if (Array.isArray(value))
    value.forEach((item, k) => leavesOf(item, `${where}[${String(k)}]`, out, first, message));
  else if (typeof value === "object" && value !== null)
    for (const [name, item] of Object.entries(value)) {
      const at = `${where}.${name}`;
      if ((name === "swap" || name === "rename") && Array.isArray(item))
        item.forEach((pair, k) => {
          if (Array.isArray(pair) && pair.length === 2) {
            leavesOf(pair[0], `${at}[${String(k)}][0]`, out, true, message);
            leavesOf(pair[1], `${at}[${String(k)}][1]`, out, first, message);
          } else leavesOf(pair, `${at}[${String(k)}]`, out, first, message);
        });
      else leavesOf(item, at, out, first, message || name === "say" || name === "addSay");
    }
  return out;
}

/** Every text of a trade, every key's (ids and labels too): its pf blocks, and per flow its ops, renames, slot rows and money. */
function allLeaves(trade: LoadedTrade): Leaf[] {
  const out: Leaf[] = [];
  for (const [name, block] of Object.entries(trade.pluginText))
    leavesOf(JSON.parse(block) as unknown, `pluginText.${name}`, out);
  for (const flow of FLOWS) {
    const part = trade.flows[flow];
    leavesOf({ ops: part.ops, rename: part.rename, slotRows: part.slotRows, money: part.money }, flow, out);
  }
  return out;
}

/** One hit of the scan: its sentence, and whether it lies on a first side or is a passive wait in a message. */
interface ScanHit {
  sentence: string;
  first: boolean;
  waits: boolean;
}

/** The hits in one text, OWN_WORD left out (its "never checked by Rosie" is C7's own). */
function scanHits(leaf: Leaf): ScanHit[] {
  const text = leaf.text.split(OWN_WORD).join("§");
  const sentences = sentencesOf(text);
  const out: ScanHit[] = [];
  for (const sentence of sentences)
    for (const { pattern, passive } of SHAPES)
      for (const match of sentence.text.matchAll(pattern))
        out.push({
          sentence: sentence.text,
          first: leaf.first,
          waits: leaf.message && passive && !negatedInClause(sentence.text, match.index),
        });
  if (leaf.first) return out;
  for (const match of text.matchAll(CHECK_VERB)) {
    if (!negationBefore(text.slice(0, match.index))) continue;
    let sentence = { text, start: 0 };
    for (const one of sentences) if (one.start <= match.index) sentence = one;
    if (negatedInClause(sentence.text, match.index - sentence.start)) continue;
    out.push({ sentence: sentence.text, first: false, waits: false });
  }
  return out;
}

/** An allow list reason's kind: a true negation, no paper, or lead note 12. */
function kind(reason: string): string {
  return reason.split(":")[0] ?? reason;
}

describe("C7's exhaustive scan (DL-901 item 16)", () => {
  it("leaves unmarked only the allow list's hits, each with its one reason, the first sides, the six messages that wait and the one NEED", () => {
    const found = new Map<string, { hits: number; files: Set<string> }>();
    const firstSides = new Map<string, { hits: number; files: Set<string> }>();
    const waits: string[] = [];
    for (const id of ALL)
      for (const leaf of allLeaves(marked(id).done.trade))
        for (const hit of scanHits(leaf)) {
          if (hit.waits) {
            waits.push(`${id} ${leaf.where}`);
            continue;
          }
          const bucket = hit.first ? firstSides : found;
          const entry = bucket.get(hit.sentence) ?? { hits: 0, files: new Set<string>() };
          entry.hits++;
          entry.files.add(id);
          bucket.set(hit.sentence, entry);
        }
    expect(waits.sort()).toStrictEqual(
      [...MESSAGES_WAITING, ...MESSAGES_NEED].map(([place]) => place).sort(),
    );
    const listed = Object.entries(ALLOWED).flatMap(([reason, list]) =>
      list.map((sentence) => [sentence, reason] as const),
    );
    const reasonOf = new Map(listed);
    expect(reasonOf.size, "each sentence is listed once, with one reason").toBe(listed.length);
    expect([...found.keys()].sort()).toStrictEqual(listed.map(([sentence]) => sentence).sort());
    expect([...firstSides.keys()].sort()).toStrictEqual([...FIRST_SIDES].sort());
    for (const sentence of ALLOWED["true negation"] ?? [])
      expect(NEGATION_WORD.test(sentence), sentence).toBe(true);
    // How many sentences, hits and trade files each reason holds.
    const tally: Record<string, { sentences: number; hits: number; files: Set<string> }> = {};
    const add = (reason: string, entry: { hits: number; files: Set<string> }): void => {
      const one = (tally[reason] ??= { sentences: 0, hits: 0, files: new Set<string>() });
      one.sentences++;
      one.hits += entry.hits;
      for (const id of entry.files) one.files.add(id);
    };
    for (const [sentence, entry] of found) add(kind(reasonOf.get(sentence) ?? ""), entry);
    for (const entry of firstSides.values()) add("a rename's first side", entry);
    const counts = Object.fromEntries(
      Object.entries(tally).map(([reason, one]) => [
        reason,
        { sentences: one.sentences, hits: one.hits, files: one.files.size },
      ]),
    );
    expect(counts).toMatchInlineSnapshot(`
      {
        "a rename's first side": {
          "files": 56,
          "hits": 465,
          "sentences": 73,
        },
        "lead note 12": {
          "files": 1,
          "hits": 1,
          "sentences": 1,
        },
        "no paper": {
          "files": 120,
          "hits": 464,
          "sentences": 180,
        },
        "true negation": {
          "files": 228,
          "hits": 1478,
          "sentences": 206,
        },
      }
    `);
  });

  it("opens every trade file with a negation within 3 words before a passive phrase, and says what became of each hit", () => {
    const reasonOf = new Map(
      Object.entries(ALLOWED).flatMap(([reason, list]) =>
        list.map((sentence) => [sentence, reason] as const),
      ),
    );
    const files = new Set<string>();
    const outcome: Record<string, number> = {};
    for (const id of ALL) {
      const { trade, done } = marked(id);
      const after = allLeaves(done.trade);
      allLeaves(trade).forEach((leaf, k) => {
        for (const sentence of sentencesOf(leaf.text))
          for (const { pattern, passive } of SHAPES) {
            if (!passive) continue;
            for (const match of sentence.text.matchAll(pattern)) {
              if (!negationBefore(leaf.text.slice(0, sentence.start + match.index))) continue;
              files.add(id);
              const what = leaf.first
                ? "a rename's first side"
                : (after[k]?.text ?? "").includes(sentence.text)
                  ? kind(reasonOf.get(sentence.text) ?? "not listed")
                  : "marked";
              outcome[what] = (outcome[what] ?? 0) + 1;
            }
          }
      });
    }
    expect({ files: [...files].sort(), outcome }).toMatchInlineSnapshot(`
      {
        "files": [
          "aba",
          "acupuncturist",
          "addiction",
          "closets",
          "credit-counselor",
          "dance",
          "dj",
          "doula",
          "ent",
          "fertility",
          "flight-school",
          "gastroenterologist",
          "golf-instructor",
          "gymnastics",
          "home-stager",
          "horse-riding",
          "hypnotherapist",
          "lab",
          "lactation",
          "limo",
          "martial-arts",
          "midwife",
          "obgyn",
          "organizer",
          "orthopedist",
          "pet-taxi",
          "psychiatrist",
          "recording-studio",
          "reiki",
          "senior-living",
          "shoe-repair",
          "shooting",
          "sitter",
          "ski-instructor",
          "sleep-clinic",
          "snow",
          "sports-coach",
          "spray-tan",
          "teeth-whitening",
          "upholstery",
          "urologist",
          "wellness-studio",
        ],
        "outcome": {
          "marked": 8,
          "no paper": 2,
          "true negation": 494,
        },
      }
    `);
  });

  it("keeps C8's offs as they are: C7 runs first in emitBundle, and no mark falls on the why of a D96 off", () => {
    for (const id of ALL) {
      const { trade, done } = marked(id);
      expect(voidOffs(done.trade).voided, id).toStrictEqual(voidOffs(trade).voided);
      for (const flow of FLOWS)
        expect(
          done.trade.flows[flow].ops.filter(isD96Off).map((op) => op.why),
          `${id} ${flow}`,
        ).toStrictEqual(trade.flows[flow].ops.filter(isD96Off).map((op) => op.why));
    }
  });
});
