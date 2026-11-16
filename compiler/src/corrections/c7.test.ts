// T-140, C7: trade text that says Rosie or Rosie's team checks, looks up or has read a license, permit, certificate,
// insurance or carrier status is the business's own word (MC C7; D96; RULES 10.1; S13-11); so is a free-text pf rule
// that waits on a paper that "checks out", or says one is "checked like a license", and names no one who checks (the
// lead's ruling on MC C7's count, DL-884). Proofs of the card that belong to C7:
//   - over all 243 trades, C7 flags the texts in the snapshot below, MC C7's five examples among them (acupuncturist,
//     camp, movers, tree, dog-walker), in 59 trade files: 31 whose texts name Rosie or Rosie's team as the one who
//     checks (c7.ts CLAIM_PATTERNS), and 28 more whose pf blocks wait on a paper no one named checks (c7.ts
//     PASSIVE_PATTERNS: the pf.license blocks of 19 building trades; appraiser, energy-audit, home-engineer, inspector,
//     surveyor, locksmith, towing, property-manager and gym). MC C7 says the Nov 4 check listed 45 such trade files; that
//     list is not available, so this build pins its own count, 59, each phrase with its trade file's example in c7.ts;
//   - after it, no text a trade's compiled overlay holds says Rosie or Rosie's team checks a paper, no pf block waits on
//     a paper no one named checks, and each text it flagged carries the C7 marker, the rest of each text as written; the
//     business's own word ("Rosie never looks a license up") is left as it is;
//   - in the bundle, the compiled overlays of the five example trades and two passive ones (concrete, gym) say no such
//     thing, and each flagged pf block carries the marker;
//   - a rename's or swap's first side (the master's own line) and a branch label are never changed; a claim in a message
//     a person reads stops the build;
//   - every change is tagged MC:C7, and C7 changes no step in the frame.
// Not here: an op's words that wait on a paper that checks out (movers' junk hauling, driving-school's learner's permit)
// belong to a step that waits, CQ-347's; C7 reads a passive wait in the pf blocks alone.
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
  PF_CLAIM_PATTERNS,
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

/** The 28 trade files C7 flags for a pf rule that waits on a paper no one named checks, and for nothing else. */
const PASSIVE_ONLY: readonly string[] = [
  "appraiser",
  "closets",
  "concrete",
  "contractor",
  "deck",
  "demolition",
  "drywall",
  "energy-audit",
  "excavation",
  "foundation",
  "glass-doors",
  "gutters",
  "gym",
  "home-engineer",
  "inspector",
  "insulation",
  "irrigation",
  "locksmith",
  "masonry",
  "painter",
  "paving",
  "property-manager",
  "radon",
  "roofer",
  "security",
  "siding",
  "surveyor",
  "towing",
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
      expect(findClaims(text, PF_CLAIM_PATTERNS), text).toHaveLength(1);
      expect(findClaims(text), text).toStrictEqual([]);
    }
    expect(patternsAt("pluginText.pf.license.blocks[0]")).toBe(PF_CLAIM_PATTERNS);
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
      expect(findClaims(text, PF_CLAIM_PATTERNS), text).toStrictEqual([]);
    expect(
      ownWord(
        "a switch from the state's form: where the state requires a certificate for a fitness coach, it's asked and checked like a license; otherwise a coach's certificate and CPR card are the business's word",
        PF_CLAIM_PATTERNS,
      ),
    ).toBe(`${OWN_WORD} otherwise a coach's certificate and CPR card are the business's word`);
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
  it("flags the texts below, MC C7's five examples among them, in 59 trade files: 31 that name Rosie or Rosie's team, 28 more with a passive wait (MC C7: the Nov 4 check listed 45)", () => {
    expect(ALL).toHaveLength(243);
    const flagged: Record<string, string[]> = {};
    const namesRosie: string[] = [];
    for (const id of ALL) {
      const { done } = marked(id);
      const where = done.marked.map((one) => one.where);
      if (where.length > 0) flagged[id] = where;
      if (done.marked.some((one) => findClaims(one.before, CLAIM_PATTERNS).length > 0)) namesRosie.push(id);
    }
    for (const [id, where] of [...EXAMPLES, ...PASSIVE_EXAMPLES]) expect(flagged[id], id).toContain(where);
    // 31 trade files name Rosie or Rosie's team as the one who checks (run 1's count, unchanged); 28 more only wait on a
    // paper no one named checks, in their pf blocks; 59 in all, pinned as this build counts them (never padded or trimmed
    // to MC C7's 45, whose list is not available).
    expect(namesRosie).toHaveLength(31);
    expect(Object.keys(flagged).filter((id) => !namesRosie.includes(id))).toStrictEqual(PASSIVE_ONLY);
    expect(Object.keys(flagged)).toHaveLength(59);
    expect(flagged).toMatchInlineSnapshot(`
      {
        "acupuncturist": [
          "pluginText.pf.license.check",
        ],
        "appliance": [
          "A ops[2].more[0]",
          "B ops[10].more[0]",
        ],
        "appraiser": [
          "pluginText.pf.license.blocks_live",
        ],
        "band": [
          "B rename[7][1]",
        ],
        "camp": [
          "pluginText.pf.staff.license",
        ],
        "chef": [
          "A ops[5].does",
          "B ops[5].does",
        ],
        "closets": [
          "pluginText.pf.license.blocks[0]",
        ],
        "clown": [
          "B rename[5][1]",
        ],
        "comedian": [
          "B rename[5][1]",
        ],
        "concrete": [
          "pluginText.pf.license.blocks[0]",
        ],
        "contractor": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.license.design_studio",
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
          "B ops[11].does",
        ],
        "dj": [
          "B rename[3][1]",
        ],
        "dog-walker": [
          "A ops[23].does",
          "A ops[75].more[0]",
          "B ops[25].does",
        ],
        "driving-school": [
          "pluginText.pf.license.blocks",
          "A ops[103].does",
          "B ops[165].does",
        ],
        "drywall": [
          "pluginText.pf.license.blocks[0]",
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
        "glass-doors": [
          "pluginText.pf.license.blocks[0]",
        ],
        "gutters": [
          "pluginText.pf.license.blocks[0]",
        ],
        "gym": [
          "pluginText.pf.license.coachCertificate",
        ],
        "home-engineer": [
          "pluginText.pf.license.blocks_live",
        ],
        "inspector": [
          "pluginText.pf.license.blocks_live",
        ],
        "insulation": [
          "pluginText.pf.license.blocks[0]",
        ],
        "interior": [
          "A rename[121][1]",
          "B rename[434][1]",
        ],
        "irrigation": [
          "pluginText.pf.license.blocks[0]",
        ],
        "locksmith": [
          "pluginText.pf.license.blocks going live",
        ],
        "masonry": [
          "pluginText.pf.license.blocks[0]",
        ],
        "movers": [
          "pluginText.pf.license.status_any_day",
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "music": [
          "pluginText.pf.license.need",
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
          "A ops[54].does",
          "B ops[53].does",
        ],
        "primary-care": [
          "A ops[62].does",
          "B ops[66].does",
        ],
        "property-manager": [
          "pluginText.pf.license.blocks going live",
        ],
        "radon": [
          "pluginText.pf.license.blocks[0]",
        ],
        "rentals": [
          "A ops[20].does",
          "B ops[20].does",
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
        ],
        "security": [
          "pluginText.pf.license.blocks[0]",
        ],
        "siding": [
          "pluginText.pf.license.blocks[0]",
        ],
        "sitter": [
          "A ops[3].does",
          "B ops[3].does",
        ],
        "surveyor": [
          "pluginText.pf.license.blocks_live",
        ],
        "tax": [
          "A ops[80].does",
          "A ops[127].more[0]",
          "B ops[33].does",
          "B ops[176].more[0]",
        ],
        "tires": [
          "A ops[35].does",
          "B ops[75].does",
        ],
        "towing": [
          "pluginText.pf.license.blocks going live",
        ],
        "tree": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.license.trust",
        ],
        "tutor": [
          "A ops[10].does",
          "A ops[179].does",
          "B ops[10].does",
          "B ops[260].does",
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
  });
});

describe("C7 in the bundle", () => {
  it("leaves no claim in the compiled overlays of MC C7's five example trades and two passive ones, and marks each flagged pf block", async () => {
    const ids = [...EXAMPLES, ...PASSIVE_EXAMPLES].map(([id]) => id);
    const built = await buildBundle({ trades: ids, master });
    for (const id of ids) {
      const overlay = built.bundle.trades[id] as {
        pluginText: Record<string, string>;
        flows: Record<FlowLetter, Record<string, unknown>>;
      };
      for (const leaf of texts(overlay, id)) {
        // A pf block is stored whole as one text (K-01 pluginText): read it with the pf blocks' patterns.
        const patterns = leaf.path.startsWith(`${id}.pluginText.`) ? PF_CLAIM_PATTERNS : CLAIM_PATTERNS;
        expect(findClaims(leaf.text, patterns), leaf.path).toStrictEqual([]);
      }
      for (const one of marked(id).done.marked) {
        const block = /^pluginText\.(pf\.[a-z_]+)/.exec(one.where)?.[1];
        if (block !== undefined) expect(overlay.pluginText[block], `${id} ${block}`).toContain(C7_MARKER);
      }
    }
    const dogWalker = built.bundle.trades["dog-walker"] as { flows: Record<FlowLetter, { ops: unknown[] }> };
    expect(JSON.stringify(dogWalker.flows.A.ops[75])).toContain(C7_MARKER);
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
