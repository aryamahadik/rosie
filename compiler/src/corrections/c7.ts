// C7 (Master Corrections section 3; D96; RULES 10.1; S13-11; `switches.verify`): trade text that says Rosie or Rosie's
// team checks, looks up or has read a license, permit, certificate, insurance or carrier status is the business's own
// word; so is a trade's free-text rule that waits on a paper that "checks out", or says one is "checked like a license",
// without saying who checks (the lead's ruling on MC C7, DL-884), or that says a paper is checked in another passive
// wording with no checker named (its ruling on round 2's open question 1, DL-894); and so is a text under a pf key that
// names a check, which carries the check verb, a lookup's or official records' result with no check verb, and Rosie's
// check in the first person (its rulings on round 4's FAIL, DL-916).
//
// The trade files were never read one by one by a reviewer (MC section 6), and some still say Rosie checks a paper on an
// official lookup: acupuncturist.json's pf.license.check, camp.json's pf.staff.license, movers.json's
// pf.license.status_any_day, tree.json's pf.license.trust, dog-walker.json's park permit ("Rosie's team checks it with
// the city"); the Nov 4 check listed 45 such trade files (its list is not available). What holds: Rosie checks nothing
// while switch "verify" is off (C4). Such text is the business's own word: Rosie never says a paper was checked by Rosie
// (S13-11), and a step that waits on such a check waits on the business's own yes alone (DD). That wait is CQ-347's, not
// this file's: C7 changes no gate, only words.
//
// How this build counts (c7.test.ts pins the list): CLAIM_PATTERNS, read in every text, flags 62 trade files, whose
// texts name Rosie or Rosie's team as the one who checks; PASSIVE_PATTERNS, read in every text but a message a person
// reads, flags 61 more, whose texts wait on, or show, a paper checked by no one named; round 5's KEY_PATTERNS,
// RESULT_PATTERNS and FIRST_PERSON_PATTERNS flag 15 more: 138 in all, 398 texts (run 1 counted 31, round 2 59, round 3
// 102, round 4 123; MC's Nov 4 count was 45). Round 3 (DL-894) added: a negation never reaches across a clause break
// (CLAUSE_BREAK), so "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day" is a claim;
// PAPER also reads the place a paper is checked where a lookup has no feed; and PASSIVE_PATTERNS reads the other passive
// wordings. Round 4 (DL-901) added: any separator is a clause break ("None needed · registration checked on the state's
// lookup, Oct 19", dance.json); a passive wording counts in an op's words as in a pf block ("None needed · registration
// 0628841, checked", snow.json); a text names a paper by its place too (namedAt). Round 5 (DL-916) added the three
// shapes the security reviewer's raw scans found: under a pf key that names a check (checkAt), the place a paper is
// checked and who checks ("the state's lookup; a person on Rosie's team within 1 business day when it's down",
// biohazard.json's and fence.json's pf.license.checked); a lookup's or records' result with no check verb ("expiry
// dates from the lookup"; "The lookup shows Leo's massage license as expired"); and Rosie in the first person ("so I'll
// check the business registration"). They are read in a trade's own words, but in an op at one of C4's verify-only
// steps (VERIFY_ONLY_STEPS), switched off while verify is off, whose lookup results c7.test.ts lists with that reason
// (DL-916 item 25, as lead note 12 leaves S1-33's lines). A message a person reads is read with CLAIM_PATTERNS alone: the
// six of movers.json's junk hauling wait on a permit that checks out, a step that waits on a check, CQ-347's (the lead's
// ruling, DL-904); six more claim a check made (notary.json's S1-23 card, DL-913; dog-walker.json's two S11-50 records
// results and the first-person S1-38 lines of tires, vehicle-wrap and window-tint, DL-916), and T-1435 fixes their
// words. c7.test.ts's exhaustive scan lists every hit that stays unmarked, with its one reason.
//
// What this file changes: the trade's own text, wherever the compiled overlay holds it (K-01 tradeOverlay): the 11
// free-text pf blocks (each stored whole, MC R3; K-01 pluginText says such text is the business's own word), every op's
// words (a words or more op's lines, an off's reason, the steps an after, before or branch op adds), the new words of
// its rename pairs and of its variants' swaps, its own slot rows and its money texts. Each sentence that makes such a
// claim (findClaims: a phrase of patternsAt() the text's place that is not negated) is replaced with OWN_WORD, S13-11's
// words for a claim with the C7 marker, so no compiled line says Rosie checked a paper and each text C7 flags carries
// the marker. A run of such sentences becomes one OWN_WORD; the text's other sentences stay as written.
//
// What it leaves: a rename's or a swap's first side, which is the master's own line it matches (C4 switches off the
// master's verify-only steps, whose words say so; T-147 marks them); a branch label, which an off names exactly; and the
// sample cast, names and story, which the overlay does not hold (MC C6). A message a person reads that makes such a
// claim stops the build (C7ClaimError): OWN_WORD and its marker are not words for a person, and no trade of fixture set
// v1 has one.
//
// What this file gives:
//   CLAIM_PATTERNS, PASSIVE_PATTERNS, WORD_PATTERNS, patternsAt()
//                                 the phrases that say Rosie checks a paper; those that wait on, or show, a paper no one
//                                 named checks; the phrases read in a trade's own words; and those read at a text's place.
//   RESULT_PATTERNS, FIRST_PERSON_PATTERNS, KEY_PATTERNS, checkAt()
//                                 round 5's: a lookup's or records' result; Rosie in the first person; and, under a pf key
//                                 that names a check (checkAt), the place a paper is checked and who checks.
//   VERIFY_ONLY_STEPS, VERIFY_ONLY_PATTERNS, onVerifyOnlyStep()
//                                 C4's verify-only steps, and the phrases read in an op at one: all but round 5's.
//   PAPER, namedAt()              what makes a text name a paper: its words, or its place.
//   findClaims(), ownWord()       the claims in one text, and the text with each run of them replaced.
//   markClaims()                  the trade with each claim replaced, and every text changed, tagged MC:C7.
//   renderMarks()                 the changes as diff lines, each starting with its tag.
//   c7                            the correction in the frame's list: it changes no step (the texts are the trade's).
import type { FlowLetter } from "../graph/types.ts";
import { PF_TEXT_KEYS, type LoadedTrade, type PluginText, type TradeId, type TradeOp } from "../load/trade";
import { VERIFY_BRANCHES, VERIFY_STEPS } from "./c4";
import type { Correction, CorrectionTag } from "./framework";

/** The marker every text C7 changes carries: the frame's tag for C7. */
export const C7_MARKER: CorrectionTag = "MC:C7";

/** What a sentence that says Rosie checks a paper becomes: S13-11's words for a claim ("shows only as the business's own word, never as checked by Rosie"), with the C7 marker. */
export const OWN_WORD = `The business's own word, never checked by Rosie (${C7_MARKER}).`;

/** Who checks, in a claim: Rosie, Rosie's team, or a person on it. */
const WHO = String.raw`(?:a person on Rosie's team|Rosie's team|Rosie)`;

/**
 * What follows a check verb when no paper is checked: a negation ("checks no permit", "checks nothing"); a job checked
 * against what the business says its license covers (S13-15: "Rosie checks each job against it", handyman.json); a date
 * ("Rosie checks the date", driving-school.json; "Rosie checks each date again on the plug-in's schedule", the renewal
 * date of a background check, dance.json); a rule checked before a page or a meeting ("Rosie checks this before the
 * secure page", tattoo.json; "Rosie checks that before a home meeting is offered", funeral.json); a message read back
 * ("Rosie reads it back", funeral.json).
 */
const NO_PAPER = String.raw`(?:no|nothing|none|each job|the job|the total|(?:the|each) date|(?:this|that) before|(?:it |them )?back)\b`;

/** One phrase that says Rosie checks a paper, and how many words before it a negation takes it back (NEGATION). */
export interface ClaimPattern {
  pattern: RegExp;
  /**
   * Words looked at before the phrase for a negation, in the phrase's own clause (CLAUSE_BREAK): a number (0: none),
   * or the whole clause before it (Infinity).
   */
  reach: number;
}

/**
 * The phrases that say Rosie or Rosie's team checks, looks up or has read a paper, each with an example from the trade
 * files. A phrase counts in a text that names a paper (PAPER), unless a negation comes within its reach before it, in
 * its own clause: "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day" (movers.json)
 * is a claim (DL-894).
 */
export const CLAIM_PATTERNS: readonly ClaimPattern[] = [
  // Rosie, or Rosie's team, checks, re-checks, looks up, has read, reads, verifies or confirms: "Rosie checks it on the
  // city's own records" (farrier.json), "a person on Rosie's team checks within 1 business day" (acupuncturist.json),
  // "Rosie re-checks it on the plug-in's schedule" (movers.json), "Rosie has read the certificate" (tree.json).
  {
    pattern: new RegExp(
      String.raw`\b${WHO}\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|looks\s+(?:(?!no\b|nothing\b)[\w'-]+\s+){0,4}?up|has\s+read|reads|verifies|confirms)\b(?!\s+${NO_PAPER})`,
    ),
    reach: 3,
  },
  // Rosie does one thing and checks: "Rosie reminds 30 days before a permit's date and checks again on it"
  // (restaurant.json).
  {
    pattern: new RegExp(
      String.raw`\bRosie\s+[a-z]+s\b[^.;:]{0,80}?\band\s+(?:re-?)?checks\b(?!\s+${NO_PAPER})`,
    ),
    reach: 3,
  },
  // Checked by Rosie: "Licenses: Checked by Rosie on the state's lookup". Any negation before it in its clause takes it
  // back ("Rosie never says a certificate was checked by Rosie", doula.json).
  {
    pattern: new RegExp(
      String.raw`\b(?:checked|re-?checked|verified|looked\s+up|confirmed|read)\s+by\s+${WHO}`,
      "i",
    ),
    reach: Infinity,
  },
  // Checked on an official lookup or record: "the camp nurse's nursing license, checked on the state's lookup"
  // (camp.json).
  {
    pattern:
      /\b(?:checked|re-?checked|verified|looked up)\s+(?:again\s+)?(?:on|against)\s+(?:the|an?)\s+[\w' ]{0,40}?(?:lookup|records?)\b/i,
    reach: 3,
  },
  // A paper on an official lookup, with no check verb of Rosie's around it: "each number on the state board's official
  // lookup" (acupuncturist.json). Any negation before it in its clause takes it back ("never checks a paper on an
  // official lookup").
  { pattern: /\b(?:on|against)\s+(?:the|an?)\s+[\w' ]{0,40}?official\s+lookup\b/i, reach: Infinity },
  // Rosie saw a paper on a lookup: "unless Rosie saw them on the certifier's own lookup" (restoration.json).
  {
    pattern: new RegExp(
      String.raw`\b${WHO}\s+(?:saw|sees|has\s+seen)\b[^.;]{0,40}?\bon\s+(?:the|an?)\s+[\w' ]{0,40}?(?:lookup|records?)\b`,
    ),
    reach: 3,
  },
];

/**
 * The phrases that wait on a paper that checks out, or say one is checked like a license, and name no one who checks
 * (the lead's ruling on MC C7, DL-884); and the other passive wordings of a paper checked with no checker named (its
 * ruling on round 2's open question 1, DL-894). While switch "verify" is off no one makes that check (C4), so such a rule
 * reads as a check Rosie made, and is the business's own word. They are read in every text but a message a person reads
 * (patternsAt; DL-901), each with its trade file's example. A phrase counts in a text that names a paper (PAPER, or its
 * place: namedAt), unless a negation comes within its reach before it, in its own clause.
 */
export const PASSIVE_PATTERNS: readonly ClaimPattern[] = [
  // A paper, or its numbers, that checks out or doesn't: "No concrete work goes live until the company's registration or
  // license checks out, where one is required" (concrete.json, as the pf.license blocks of 18 more building trades
  // say), "no appraisal is offered until the company's and the appraiser's numbers check out" (appraiser.json;
  // energy-audit, home-engineer, inspector, surveyor), "A person whose license doesn't check out is never sent"
  // (locksmith.json; towing), "Where the state's form says a license is needed and none checks out" (property-manager.json).
  // A student's learner's permit is the customer's own paper, which the instructor checks in person (driving-school.json):
  // no business paper.
  {
    pattern:
      /(?<!learner's\s)\b(?:licen[cs]es?|registrations?|permits?|authority|certificates?|numbers?|none)\s+(?:checks?|(?:doesn't|does\s+not|don't|do\s+not)\s+check)\s+out\b/i,
    reach: 3,
  },
  // A paper checked like a license, by no one named: "where the state requires a certificate for a fitness coach, it's
  // asked and checked like a license" (gym.json), "the studio's number and each designer's are checked like any license"
  // (contractor.json).
  { pattern: /\bchecked\s+like\s+(?:a|an|any)\s+licen[cs]e\b/i, reach: 3 },
  // The other passive wordings (the lead's ruling, DL-894): a paper checked, with no one named who checks.
  // A paper, or its number, that is or was checked: "the city's or county's license is checked, by the customer's
  // address" (hvac.json), "each one's number is checked" (contractor.json; interior), "its business registration is
  // checked" (tree.json's wood yard), "Sam's commission was checked already" (notary.json at S1-23, DL-901). A driver's
  // license is a person's identity, and "checked by" names who checks ("their driver's license is checked by the
  // business", pet-taxi.json).
  {
    pattern:
      /(?<!driver's\s)\b(?:licen[cs]es?|registrations?|permits?|certificates?|credentials?|commissions?|numbers?)\s+(?:is|are|was|were)\s+(?:re-?)?checked\b(?!\s+by\b)/i,
    reach: 3,
  },
  // The license that is the one checked: "the license for the job's address is the one checked" (electrician.json).
  { pattern: /\bis\s+the\s+one\s+checked\b/i, reach: 3 },
  // Checked before a person is named on a job: "Trade subcontractors hold their own, checked before they're named on a
  // job" (contractor.json; gutters, pool-builder, roofer, siding), "both are checked before they are named on a job"
  // (irrigation.json).
  { pattern: /\bchecked\s+before\s+(?:they're|they\s+are)\s+named\b/i, reach: 3 },
  // A paper shown only once checked: "a certificate shows only once checked" (dog-trainer.json), "a national
  // certificate is shown only once checked" (speech-therapist.json), "shown only as 'checked' once it is"
  // (gunsmith.json).
  // "A certificate is a claim, shown only once it's checked" (dog-trainer.json's whys, DL-901).
  {
    pattern: /\b(?:shows?|shown)\s+only\s+(?:once\s+(?:it's\s+|it\s+is\s+)?checked|as\s+'checked'\s+once)\b/i,
    reach: 3,
  },
  // A person checked for the papers a form asks: "a threader is checked for what the form asks instead (an ID, a
  // course, insurance)" (lash-brow.json).
  { pattern: /\bchecked\s+for\s+what\s+the\s+form\s+asks\b/i, reach: 3 },
  // A rule that starts "Checked", its paper named by its block: "Checked on each renewal date from the state form"
  // (cpa.json; funeral, lawyer, mortgage, realtor), "Checked each year, and on the date from the state's form"
  // (advisor.json), "checked at sign-up and re-checked" (vehicle-inspection.json). "Checked by Rosie" is a phrase of
  // CLAIM_PATTERNS; "Checked in: Alex M., Sat 11:00am" (advisor.json and 60 more) is a customer's check-in.
  { pattern: /^(?:re-?)?checked\b(?!\s+(?:by|in|out)\b)/i, reach: 3 },
  // Credentials shown as checked: "Credentials show exactly as checked" (tax.json).
  { pattern: /\b(?:shows?|shown)\s+(?:exactly\s+)?as\s+checked\b/i, reach: 3 },
  // The business's word unless checked: "shown as 'as stated' unless it's checked" (coach.json), "shown as the
  // business's word unless checked" (trainer.json).
  { pattern: /\bunless\s+(?:it's\s+|it\s+is\s+)?checked\b/i, reach: 3 },
  // Checked where required: "a coach's certificate and CPR card: a switch from the state's form (checked where
  // required, otherwise the gym's word)" (gym.json).
  { pattern: /\bchecked\s+where\s+required\b/i, reach: 3 },
  // A wait on a paper confirmed by no one named: "customers see no permit claim until it's confirmed" (limo.json). No
  // word before "until" takes the wait back (reach 0): the "no" there is the claim's, not the check's.
  { pattern: /\buntil\s+(?:it's|it\s+is)\s+(?:confirmed|checked)\b/i, reach: 0 },
  // A paper, or its number, shown as checked (the lead's ruling, DL-901): "None needed · registration 0628841, checked"
  // (snow.json, the words op at S2-21, the staff table's "Licenses" cell), "None needed; registration checked Oct 19"
  // (dj.json). "Checked by" names who checks; a driver's license checked is a driver's skill ("Driver's license checked
  // · keys held", concierge.json), no business paper.
  {
    pattern:
      /(?<!driver's\s)\b(?:licen[cs]es?|registrations?|permits?|certificates?|credentials?|insurance)(?:\s+#?[A-Z]{0,3}\d[\w-]*)?,?\s+(?:re-?)?checked\b(?!\s+by\b)/i,
    reach: 3,
  },
  // The other passive wordings the exhaustive scan found (DL-901 item 16), each a paper checked or confirmed by no one
  // named: "Where a state's form names a license for this work, it's asked and checked then" (coach.json;
  // college-admissions, image-consultant, matchmaker, personal-shopper, psychic), "it's asked then and checked"
  // (pet-waste.json), "its number is asked here and checked the same way" (tires.json).
  { pattern: /\basked\s+(?:here\s+|then\s+)?and\s+checked\b/i, reach: 3 },
  // "Where the city requires a permit to walk dogs in its parks, it's checked before Reese is offered for it"
  // (dog-walker.json).
  { pattern: /\b(?:it's|it\s+is)\s+checked\s+before\b/i, reach: 3 },
  // "Mowing, cleanups and aeration go live on the business registration while it's checked" (lawn.json).
  { pattern: /\bwhile\s+(?:it's|it\s+is)\s+checked\b/i, reach: 3 },
  // A person checked for the license their work needs: "Massage licenses each therapist, so Kofi is checked"
  // (cpr-training.json; gym, pilates, tours).
  { pattern: /\bso\s+[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*)?\s+(?:is|are)\s+checked\b/, reach: 3 },
  // "Licenses already checked stay as they are" (daycare.json).
  {
    pattern: /\b(?:licen[cs]es?|registrations?|permits?|certificates?|credentials?)\s+already\s+checked\b/i,
    reach: 3,
  },
  // A wait on a paper confirmed by no one named: "Nobody is offered to customers until any license they need is
  // confirmed and Sam says yes" (restoration.json), "until their PTIN and credentials are confirmed" (tax.json). As in
  // "until it's confirmed", no word before "until" takes the wait back (reach 0).
  {
    pattern:
      /\buntil\s+[\w' ]{0,30}?\b(?:licen[cs]es?|credentials?|permits?|certificates?|registrations?)\b[\w' ]{0,20}?\s(?:is|are)\s+confirmed\b/i,
    reach: 0,
  },
  // "Customers see each preparer's credential only as checked" (tax.json).
  { pattern: /\bonly\s+as\s+checked\b/i, reach: 3 },
];

/**
 * A lookup, or an official body's records, where a paper is looked up (DL-916 item 23): "the state's lookup", "the
 * federal pilot lookup", "the city's records", "the city's permit records". A person's or a business's own record ("a
 * returning patient's record", "the agent's own records") is no lookup. Words between a preposition and the lookup never
 * hold another lookup (NOT_LOOKUP), so "from the lookup's 'The lookup is down'" names the lookup's branch, no result.
 */
const LOOKUP = String.raw`(?:lookups?|(?:state|city|county|town|board|federal|official)(?:'s)?\s+(?:[\w-]+\s+)?records?)`;
const NOT_LOOKUP = String.raw`(?!lookup)[\w'-]+\s+`;

/**
 * A lookup's or official records' result, with no check verb (the lead's ruling on round 4's FAIL 2, DL-916 item 23): a
 * paper "shows as expired on the state's lookup", "the lookup shows" or "the city's records show" it, a date comes "from
 * the lookup". Each reads as a check made, which no one makes while switch "verify" is off (C4), so it is the business's
 * own word in a trade's own words. A message a person reads is not read with them (patternsAt): the two of dog-walker's
 * S11-50 are c7.test.ts's MESSAGES_NEED, whose words T-1435 fixes. An op at one of C4's verify-only steps is not read
 * with them either (VERIFY_ONLY_STEPS, DL-916 item 25). A phrase counts in a text that names a paper (PAPER, or its
 * place: namedAt), unless a negation comes within its reach before it, in its own clause.
 */
export const RESULT_PATTERNS: readonly ClaimPattern[] = [
  // The lookup or the records as the one that shows, has, lists, finds or answers, or doesn't find: "The lookup shows
  // Leo's massage license as expired" (pilates.json, a rename's new side), "The state's lookup has no massage license
  // with the number Eli sent" (yoga.json, one too), "Sasha's card is checked again when the lookup answers"
  // (caterer.json, one too), "The city's records show Quinn's park permit as suspended today" (dog-walker.json at S11-50,
  // a message), "The state's business lookup doesn't find registration 2019-0451 for the company" (band.json, a rename's
  // new side). A result the lookup gives is a check made, whatever it finds; "We couldn't find ... on the state's
  // lookup" is Rosie's own voice at S1-33, lead note 12's, where the lookup is not the one that finds.
  {
    pattern: new RegExp(
      String.raw`\b${LOOKUP}\s+(?:(?:now|still|also|then)\s+)?(?:shows?|showed|says?|said|lists?|listed|has|had|holds?|finds?|found|answers?|answered|returns?|returned|catches\s+up|caught\s+up|matches?|matched|confirms?|confirmed|gives?|gave|(?:doesn't|does\s+not|didn't|did\s+not|can't|cannot|couldn't|could\s+not)\s+(?:find|show|list|match))\b`,
      "i",
    ),
    reach: 3,
  },
  // A paper shown as it stands on a lookup or records: "Leo's massage license shows as expired on the state's lookup"
  // (pilates.json at S2-13, a message).
  {
    pattern: new RegExp(
      String.raw`\b(?:shows?|showed|shown|listed|appears?)\s+(?:as\s+)?(?:${NOT_LOOKUP}){0,4}?(?:on|in)\s+(?:the|an?)\s+(?:${NOT_LOOKUP}){0,3}?${LOOKUP}\b`,
      "i",
    ),
    reach: 3,
  },
  // A date or a status read from a lookup: "expiry dates from the lookup" (biohazard.json's pf.license.renewals), "the
  // expiry date from the lookup" (fence.json's).
  {
    pattern: new RegExp(String.raw`\bfrom\s+(?:the|an?)\s+(?:${NOT_LOOKUP}){0,3}?${LOOKUP}\b(?!'s)`, "i"),
    reach: 3,
  },
];

/**
 * Rosie in the first person, saying it checks a paper (the lead's ruling on round 4's FAIL 3, DL-916 item 24): "Mobile
 * tire service needs no state license where you work, so I'll check the business registration." (tires.json at S1-38).
 * WHO reads "I" where Rosie speaks: a trade's own words outside a message a person reads (an op's words, a rename's new
 * side: "Wrap work needs no state license where you work, so I'll check the business registration.", vehicle-wrap.json
 * and window-tint.json). In a message a person reads it is not read: the three of tires, vehicle-wrap and window-tint at
 * S1-38 are c7.test.ts's MESSAGES_NEED, whose words T-1435 fixes. A check of no paper is no claim (NO_PAPER).
 */
export const FIRST_PERSON_PATTERNS: readonly ClaimPattern[] = [
  {
    pattern: new RegExp(
      String.raw`\bI(?:'ll|'ve|'d|\s+will|\s+have|\s+had|\s+would)?\s+(?:(?:also|then|first|again|only|still|now|just|already)\s+)?(?:re-?check(?:ed)?|check(?:ed)?|look(?:ed)?\s+(?:(?!no\b|nothing\b)[\w'-]+\s+){0,4}?up|verif(?:y|ied)|confirm(?:ed)?)\b(?!\s+${NO_PAPER})`,
    ),
    reach: 3,
  },
];

/**
 * What a pf block's text says under a key that names a check (checkAt; the lead's ruling on round 4's FAIL 1, DL-916
 * item 22), where the key carries the check verb: the place a paper is checked ("the state's lookup", "the state's
 * license lookup", "the state's or city's business lookup") and who checks ("a person on Rosie's team within 1 business
 * day when it's down"): "checked: the state's lookup; a person on Rosie's team ..." (biohazard.json and fence.json's
 * pf.license.checked) says Rosie's team checks a paper on the state's lookup, MC C7's own acupuncturist example. Any
 * negation before it in its clause takes it back ("the school's own check, with no lookup", driving-school.json). A
 * sentence there that names only the paper and the owner who keeps it ("The owner keeps the papers", architect.json;
 * "the owner is responsible for the licenses they add", occupational-therapist.json) says no one checks it.
 */
export const KEY_PATTERNS: readonly ClaimPattern[] = [
  {
    pattern: new RegExp(String.raw`\b(?:${LOOKUP}(?!'s)|data\s+feed|(?:own|official)\s+site)\b`, "i"),
    reach: Infinity,
  },
  { pattern: /\b(?:a\s+person\s+on\s+Rosie's\s+team|Rosie's\s+team)\b/, reach: Infinity },
];

/**
 * The phrases read in a trade's own words: CLAIM_PATTERNS, PASSIVE_PATTERNS, then round 5's RESULT_PATTERNS and
 * FIRST_PERSON_PATTERNS (DL-916).
 */
export const WORD_PATTERNS: readonly ClaimPattern[] = [
  ...CLAIM_PATTERNS,
  ...PASSIVE_PATTERNS,
  ...RESULT_PATTERNS,
  ...FIRST_PERSON_PATTERNS,
];

/**
 * The phrases read in an op at one of C4's verify-only steps (VERIFY_ONLY_STEPS): WORD_PATTERNS without round 5's. Such a
 * step is switched off while verify is off, so its lookup results stay as written and c7.test.ts lists them with the
 * reason "C4's verify-only branch, switched off while verify is off" (DL-916 item 25, the same position as lead note 12
 * on S1-33's lines); a claim the rounds before marked there stays marked.
 */
export const VERIFY_ONLY_PATTERNS: readonly ClaimPattern[] = [...CLAIM_PATTERNS, ...PASSIVE_PATTERNS];

/** The phrases read under a key that names a check (checkAt): WORD_PATTERNS, then KEY_PATTERNS. */
const KEY_WORD_PATTERNS: readonly ClaimPattern[] = [...WORD_PATTERNS, ...KEY_PATTERNS];

/**
 * The steps only switch "verify" lights, which C4 switches off (c4.ts): the steps its branches hold (S1-33, S2-12,
 * S2-13, S2-14, S11-99) and its steps (S12-19, S13-41, S13-43).
 */
export const VERIFY_ONLY_STEPS: ReadonlySet<string> = new Set([
  ...VERIFY_BRANCHES.map(([, holds]) => holds),
  ...VERIFY_STEPS,
]);

/** A pf key that names a check, the key itself the check: "check", "checked", "checks", "how it's checked". */
const CHECK_KEY = /^(?:how\s+(?:it's|it\s+is|they're|they\s+are)\s+)?(?:re-?)?check(?:s|ed)?$/i;

/**
 * Whether a text's place is a pf block's key that names a check (DL-916 item 22): pluginText.pf.license.checked
 * (biohazard.json, fence.json), pf.license.check (acupuncturist.json and 169 more), pf.license.how it's checked. A key
 * that names another kind of check (a background check, a customer's check-in, a recall check) is not one.
 */
export function checkAt(where: string): boolean {
  if (!where.startsWith("pluginText.")) return false;
  const keys = where.replace(/\[\d+\]/g, "").split(".");
  return CHECK_KEY.test(keys[keys.length - 1] ?? "");
}

/** A place inside a message a person reads: a say or addSay list (`A ops[11].say[2][0]`). */
const IN_MESSAGE = /\.(?:say|addSay)\[/;

/**
 * The phrases read in a text at its place (a ClaimMark's `where`): WORD_PATTERNS in a pf block, an op's words, a
 * rename's new side, a slot row or a money text (DL-901: a paper checked with no checker named is the business's own
 * word in an op as in a pf block), with KEY_PATTERNS too under a pf key that names a check (checkAt, DL-916 item 22);
 * VERIFY_ONLY_PATTERNS in an op at one of C4's verify-only steps (`verifyOnly`, onVerifyOnlyStep(), DL-916 item 25);
 * CLAIM_PATTERNS alone in a message a person reads, since OWN_WORD is no word for a person and marking one would stop
 * the build (C7ClaimError). Six such messages wait on a permit that "checks out" (movers.json's junk hauling): steps that
 * wait on a check, CQ-347's (the lead's ruling, DL-904; c7.test.ts's MESSAGES_WAITING). Six more are c7.test.ts's
 * MESSAGES_NEED, whose words T-1435 fixes: notary.json's S1-23 card shows a paper checked by no one named (DL-913),
 * dog-walker.json's two S11-50 messages a records' result (DL-916 item 23), and the S1-38 lines of tires, vehicle-wrap
 * and window-tint Rosie's check in the first person (item 24).
 */
export function patternsAt(where: string, verifyOnly = false): readonly ClaimPattern[] {
  if (IN_MESSAGE.test(where)) return CLAIM_PATTERNS;
  if (verifyOnly) return VERIFY_ONLY_PATTERNS;
  return checkAt(where) ? KEY_WORD_PATTERNS : WORD_PATTERNS;
}

/**
 * A text names a paper: a license, permit, certificate, registration, insurance, bond, credential, carrier, authority or
 * a notary's commission, a paper's renewal ("A renewal receipt counts while it's checked", daycare.json at S11-50;
 * DL-901), or an official lookup; or the place a person checks one where a lookup has no data feed or is down
 * (DL-894): a data feed, the state's own or an official site, the state's records, or the city ("Where a state has no
 * data feed, a person on Rosie's team checks the state's own site and keeps a screenshot", carpet.json and 21 more; "a
 * person on Rosie's team checks with the city another way", dog-walker.json, after MC C7's "Rosie's team checks it with
 * the city"). A text also names a paper by its place (namedAt, markClaims): a pf block, or a key in one, that names a
 * paper; a rename's or a swap's first side.
 */
export const PAPER =
  /licen[cs]|permit|certif|insur|registration|credential|\bbond|carrier|\bauthority|\bcommission|\brenewal|lookup|\bpapers?\b|\bdata\s+feed\b|\b(?:own|official)\s+site\b|\bstate's\s+records\b|\bwith\s+the\s+city\b/i;

/**
 * Whether a text's place names the paper its words leave out (DL-901): a pf block, or a key in one, that names a paper
 * ("Checked on each end date; a lapse pauses that person's bookings" is private-investigator.json's
 * pf.license.renewals). A rename's or a swap's new side also names the paper its first side names (markClaims): "Sam
 * sends a photo of it, and Rosie checks it again right away" replaces "Sam sends a photo of the license, ..."
 * (dance.json, yoga.json).
 */
export function namedAt(where: string): boolean {
  return where.startsWith("pluginText.") && PAPER.test(where.slice("pluginText.".length));
}

/** A word that negates the phrase after it: "not checked by Rosie", "never as checked by Rosie", "Nobody is shown as checked". */
const NEGATION = /\b(?:never|not|no|nor|cannot|nothing|none|nobody)\b|n't\b/i;

/**
 * A sentence whose colon introduces a list after a lone negation: "Never: call a license checked, or let it stand for
 * control (S1-75)." (aba.json), "Never: let a license stand for control (S1-75), or say a license is checked."
 * (occupational-therapist.json). That colon is no clause break: the negation governs each item of its list, across the
 * list's commas too (DL-901: a colon is kept out of the clause breaks only where it introduces a list).
 */
const LIST_NEGATION = /^\s*(?:never|none|no|not|nothing|nobody)\s*:/i;

/**
 * A clause break: any separator (DL-901): a comma, a semicolon, a colon or a sentence end (".", "!" or "?") before white
 * space or the end; a "·", "•", "—", "–", "|" or "/" anywhere; a line break. A negation never reaches across one
 * (DL-894): in "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day" (movers.json),
 * the "no" belongs to the first clause, and the second says Rosie's team checks; in "None needed · registration checked
 * on the state's lookup, Oct 19" (dance.json), the "None" belongs to the first item.
 */
const CLAUSE_BREAK = /[,;:.!?](?=\s|$)|[·•—–|/\n]/;

/** One sentence and the separator after it, as a text splits (the separator is "" at the end). */
interface Sentence {
  text: string;
  after: string;
}

/**
 * A text's sentences: each ends at ".", ";", "!" or "?" before white space, at a "·", "•" or "|" between spaces (an
 * item of a row: "None needed · registration 0628841, checked", snow.json), at a line break, or at the end.
 */
function sentences(text: string): Sentence[] {
  const parts = text.split(/((?<=[.;!?])\s+|\s+[·•|]\s+|\s*\n\s*)/);
  const out: Sentence[] = [];
  for (let k = 0; k < parts.length; k += 2) out.push({ text: parts[k] ?? "", after: parts[k + 1] ?? "" });
  return out;
}

/**
 * Whether a negation comes within `reach` words (punctuation alone is no word) before `at`, in the clause `at` lies in:
 * the words looked at stop at the last clause break before it (CLAUSE_BREAK); or the phrase is an item of a list a lone
 * negation's colon introduces (LIST_NEGATION).
 */
function negated(sentence: string, at: number, reach: number): boolean {
  const list = LIST_NEGATION.exec(sentence);
  if (list !== null && list[0].length <= at) return true;
  const clauses = sentence.slice(0, at).split(CLAUSE_BREAK);
  const words = (clauses[clauses.length - 1] ?? "").split(/\s+/).filter((word) => /[a-z]/i.test(word));
  return words.slice(Math.max(0, words.length - reach)).some((word) => NEGATION.test(word));
}

/** Whether a sentence says Rosie or Rosie's team checks a paper: one of the patterns matches where no negation takes it back. */
function claims(sentence: string, patterns: readonly ClaimPattern[]): boolean {
  for (const { pattern, reach } of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of sentence.matchAll(global)) if (!negated(sentence, match.index, reach)) return true;
  }
  return false;
}

/**
 * The sentences of a text that say Rosie or Rosie's team checks a paper, in order (none where the text names no paper,
 * in its words or, when `named`, by its place), read with CLAIM_PATTERNS unless other patterns are given (patternsAt).
 */
export function findClaims(
  text: string,
  patterns: readonly ClaimPattern[] = CLAIM_PATTERNS,
  named = false,
): string[] {
  if (!named && !PAPER.test(text)) return [];
  return sentences(text)
    .map((sentence) => sentence.text)
    .filter((sentence) => claims(sentence, patterns));
}

/**
 * The text with each run of claim sentences (findClaims, with the same patterns and `named`) replaced with one OWN_WORD;
 * the text itself when it has none.
 */
export function ownWord(
  text: string,
  patterns: readonly ClaimPattern[] = CLAIM_PATTERNS,
  named = false,
): string {
  if (findClaims(text, patterns, named).length === 0) return text;
  let out = "";
  let inRun = false;
  for (const part of sentences(text)) {
    if (claims(part.text, patterns)) {
      if (!inRun) out += OWN_WORD;
      inRun = true;
      // The separator after the run's last sentence follows OWN_WORD.
      out = out.replace(/\s*$/, part.after);
      continue;
    }
    inRun = false;
    out += part.text + part.after;
  }
  return out;
}

/**
 * A claim in a message a person reads, which C7 cannot make the business's own word in OWN_WORD's terms. An Error, not
 * framework.ts's CorrectionError: the frame imports this file, so this file imports only its types (as c4.ts does).
 */
export class C7ClaimError extends Error {
  override name = "C7ClaimError";
}

/** One trade text C7 changed. */
export interface ClaimMark {
  tag: CorrectionTag;
  trade: TradeId;
  /** Where the text is: `pluginText.pf.license.check`, `A ops[23].does`, `B rename[7][1]`. */
  where: string;
  before: string;
  after: string;
}

/** A trade with C7's texts, and each text changed. */
export interface MarkedTrade {
  trade: LoadedTrade;
  marked: ClaimMark[];
}

const TAG: CorrectionTag = "MC:C7";
const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** Keys whose values are never words: ids, lanes, gates and the names other ops match exactly (a branch label). */
const NOT_WORDS: ReadonlySet<string> = new Set([
  "id",
  "at",
  "op",
  "label",
  "who",
  "to",
  "via",
  "as",
  "line",
  "needs",
  "gives",
  "reads",
  "tells",
  "when",
  "sets",
  "flow",
  "phase",
  "type",
  "kind",
  "slot",
  "link",
  "stop",
]);

/** Keys that hold [old, new] pairs: only the new side is the trade's own words (the old side is the master's line). */
const PAIR_LISTS: ReadonlySet<string> = new Set(["swap"]);

/** Keys that hold messages: [from, to, text, elements], or [from, to, elements]. */
const MESSAGE_LISTS: ReadonlySet<string> = new Set(["say", "addSay"]);

type Mark = (where: string, before: string, after: string) => void;

function key(path: string, part: string | number): string {
  return typeof part === "number" ? `${path}[${String(part)}]` : path === "" ? part : `${path}.${part}`;
}

/**
 * The value with each claim in its words replaced (a copy where anything changed, the value itself where nothing did),
 * each text read with the patterns of its place (patternsAt). `inMessage` is the message the value lies in, when it lies
 * in one; `named`, whether the first side its value replaces names a paper; `verifyOnly`, whether the value lies in an
 * op at one of C4's verify-only steps (onVerifyOnlyStep).
 */
function rewrite(
  value: unknown,
  path: string,
  mark: Mark,
  inMessage: string | null,
  named = false,
  verifyOnly = false,
): unknown {
  if (typeof value === "string") {
    const next = ownWord(value, patternsAt(path, verifyOnly), named || namedAt(path));
    if (next === value) return value;
    if (inMessage !== null)
      throw new C7ClaimError(
        `${path}: a message a person reads says Rosie checks a paper (MC C7); it needs the business's own words`,
      );
    mark(path, value, next);
    return next;
  }
  if (Array.isArray(value)) {
    const out = value.map((item, k) => rewrite(item, key(path, k), mark, inMessage, named, verifyOnly));
    return out.some((next, k) => next !== value[k]) ? out : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      const next = rewriteField(name, item, key(path, name), mark, inMessage, named, verifyOnly);
      if (next !== item) changed = true;
      out[name] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** One field of an object rewritten: as it is where it holds no words; a pair list's new sides; a message list's words. */
function rewriteField(
  name: string,
  item: unknown,
  at: string,
  mark: Mark,
  inMessage: string | null,
  named: boolean,
  verifyOnly: boolean,
): unknown {
  if (NOT_WORDS.has(name)) return item;
  if (PAIR_LISTS.has(name) && Array.isArray(item)) return newSides(item, at, mark, inMessage, verifyOnly);
  if (MESSAGE_LISTS.has(name) && Array.isArray(item)) return messages(item, at, mark);
  return rewrite(item, at, mark, inMessage, named, verifyOnly);
}

/**
 * A list of [old, new] pairs with each new side rewritten, naming the paper its old side names (namedAt); the old side
 * is the master's line, matched as written.
 */
function newSides(
  pairs: readonly unknown[],
  path: string,
  mark: Mark,
  inMessage: string | null,
  verifyOnly = false,
): unknown[] {
  const out = pairs.map((pair, k): unknown => {
    if (!Array.isArray(pair) || pair.length !== 2) return pair;
    const named = typeof pair[0] === "string" && PAPER.test(pair[0]);
    const next = rewrite(pair[1], `${path}[${String(k)}][1]`, mark, inMessage, named, verifyOnly);
    return next === pair[1] ? pair : [pair[0], next];
  });
  return out.some((next, k) => next !== pairs[k]) ? out : (pairs as unknown[]);
}

/** A list of messages, each read as a message a person reads: its lanes are not words. */
function messages(list: readonly unknown[], path: string, mark: Mark): unknown[] {
  const out = list.map((message, k): unknown => {
    const at = `${path}[${String(k)}]`;
    if (!Array.isArray(message)) return rewrite(message, at, mark, at);
    const words = message.slice(2);
    const next = rewrite(words, at, mark, at) as unknown[];
    return next === words ? message : [message[0], message[1], ...next];
  });
  return out.some((next, k) => next !== list[k]) ? out : (list as unknown[]);
}

/** Whether an op lies at one of C4's verify-only steps (VERIFY_ONLY_STEPS), where round 5's phrases are not read. */
export function onVerifyOnlyStep(op: { at?: unknown }): boolean {
  return typeof op.at === "string" && VERIFY_ONLY_STEPS.has(op.at);
}

/** A flow's ops, each rewritten with the patterns of its step (onVerifyOnlyStep, DL-916 item 25). */
function rewriteOps(ops: TradeOp[], path: string, mark: Mark): TradeOp[] {
  const out = ops.map(
    (op, k) => rewrite(op, key(path, k), mark, null, false, onVerifyOnlyStep(op)) as TradeOp,
  );
  return out.some((next, k) => next !== ops[k]) ? out : ops;
}

/**
 * The trade with every claim that Rosie or Rosie's team checks a paper (and, outside a message a person reads, every
 * wait on, or show of, a paper that no one named checks, and, but in an op at one of C4's verify-only steps, every
 * lookup's result, first-person check and check key's place or checker) replaced with OWN_WORD, in each text the
 * compiled overlay holds (see the top of this file), and each text changed, tagged MC:C7. The trade given is not
 * changed; one with no claim is given back as it is. Throws C7ClaimError for a claim in a message a person reads.
 */
export function markClaims(trade: LoadedTrade): MarkedTrade {
  const marked: ClaimMark[] = [];
  const mark: Mark = (where, before, after) => {
    marked.push({ tag: TAG, trade: trade.id, where, before, after });
  };
  let out = trade;

  let pluginText: PluginText | null = null;
  for (const name of PF_TEXT_KEYS) {
    const block: unknown = JSON.parse(trade.pluginText[name]);
    const next = rewrite(block, `pluginText.${name}`, mark, null);
    if (next === block) continue;
    pluginText ??= { ...trade.pluginText };
    pluginText[name] = JSON.stringify(next);
  }
  if (pluginText !== null) out = { ...out, pluginText };

  for (const flow of FLOWS) {
    const part = trade.flows[flow];
    const ops = rewriteOps(part.ops, `${flow} ops`, mark);
    const rename = newSides(part.rename, `${flow} rename`, mark, null) as typeof part.rename;
    const slotRows = rewrite(part.slotRows, `${flow} slotRows`, mark, null) as typeof part.slotRows;
    const money = rewrite(part.money, `${flow} money`, mark, null) as typeof part.money;
    if (ops === part.ops && rename === part.rename && slotRows === part.slotRows && money === part.money)
      continue;
    out = { ...out, flows: { ...out.flows, [flow]: { ...part, ops, rename, slotRows, money } } };
  }
  return { trade: out, marked };
}

/** The changes as diff lines: `MC:C7 - <trade> <where>: <before>` and `MC:C7 + <trade> <where>: <after>`. */
export function renderMarks(marked: readonly ClaimMark[]): string[] {
  return marked.flatMap((one) => [
    `${one.tag} - ${one.trade} ${one.where}: ${one.before}`,
    `${one.tag} + ${one.trade} ${one.where}: ${one.after}`,
  ]);
}

/** C7: a trade's claims that Rosie checks a paper are the business's own word. They are the trade's texts, so the correction changes no step. */
export const c7: Correction = {
  id: "C7",
  title:
    "Trade text that says Rosie or Rosie's team checks a license, permit, certificate, insurance or carrier status is the business's own word",
  source:
    "Master Corrections C7; D96; RULES 10.1; S13-11; switches.verify in master-A.json and master-B.json",
  apply() {
    // No step changes: C7's texts are the trade's (markClaims).
  },
};
