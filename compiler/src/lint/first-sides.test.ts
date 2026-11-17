// T-1439: the first-side lint (first-sides.ts; the security reviewer's new task on T-140 round 4 and its note b on round
// 5, DL-927). Proofs of the card:
//   (1) every rename and swap pair of the 243 trades, in both flows, whose first side matches no text the master and the
//       trade's own ops lay at its flow is listed, each with its trade file and lines, and the lint reports without
//       throwing; today's list is pinned by place (first-sides.places.txt) with its counts; the card's known members are
//       in it (vehicle-wrap.json:413-414, window-tint.json:440-441, and the "Everyone's licenses are confirmed on the
//       state's lookup." and "official lookup" first sides of 17 trade files, which no master file holds); a made-up pair
//       that matches nothing is listed, and a pair that matches master text is not;
//   (2) where each listed pair was meant to rename on the master's own flow (masterPlaces), marked pair by pair in the
//       list by place, none of them a line that claims a check made while verify is off; and what a person reads, by
//       compiling the trade (the bundle's trade, its applied flow and Master Corrections, verify off), where a listed
//       pair was meant to rename, and whether it claims a check made while verify is off: the pairs meant for one of the
//       master's own claim lines, and the card's known members. None does, so the corrections layer changes nothing for
//       them (the master's own S2-11 and S1-32 lines say they hold only with checks on, or that checks are off now);
//   (3) each listed pair's reason as found.
// Fixture set v1 holds no swap pair in any trade (only master-B.json's own variants swap), so the swaps are proved on a
// made-up op.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MASTER_DIR, loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, parseTrade } from "../load/trade";
import {
  REASONS,
  claimsWhileOff,
  compiledLines,
  firstSideFindings,
  holdsClaim,
  jsonLines,
  masterClaimLines,
  masterPlaces,
  meantFor,
  pairsAtClaimLines,
  placeOf,
  placesText,
  sharedRun,
  standsIn,
  tradeText,
  wordsOf,
  type FirstSideFinding,
  type FirstSideReport,
  type LintedTrade,
  type ReadLine,
} from "./first-sides";

// Reading all 243 trades and compiling the known members' trades is heavy (a resource guard, not part of any claim).
vi.setConfig({ testTimeout: 1_200_000 });

const master = loadMaster();
const ALL = listTradeIds();

let loadedMemo: LintedTrade[] | null = null;
function loaded(): LintedTrade[] {
  loadedMemo ??= ALL.map((id) => ({ trade: loadTrade(id), text: tradeText(id) }));
  return loadedMemo;
}

let reportMemo: FirstSideReport | null = null;
/** The lint over every trade of fixture set v1, made once. */
function report(): FirstSideReport {
  reportMemo ??= firstSideFindings(master, loaded());
  return reportMemo;
}

/** A listed pair by its file and first side line. */
function at(file: string, line: number): FirstSideFinding | undefined {
  return report().findings.find((one) => one.file === file && one.lines[0] === line);
}

describe("the lint's reading of a trade file and of the words a rename runs on", () => {
  it("gives each value of a JSON text its line, by its path", () => {
    const text = '{\n "a": [\n  "x",\n  [\n   "y",\n   "z"\n  ]\n ],\n "b": {"c": 1}\n}\n';
    const lines = jsonLines(text);
    expect(lines.get(JSON.stringify(["a", 0]))).toBe(3);
    expect(lines.get(JSON.stringify(["a", 1, 0]))).toBe(5);
    expect(lines.get(JSON.stringify(["a", 1, 1]))).toBe(6);
    expect(lines.get(JSON.stringify(["b", "c"]))).toBe(9);
  });

  it("matches a first side as renameAll does: whole words, as written, never across two texts or inside a keep slot", () => {
    const words = wordsOf(["Rosie checks the shop's license.", "a {{keep:barbershop}} rule", "Shops"]);
    expect(standsIn("shop's license", words)).toBe(true);
    // An apostrophe is no letter or digit, so "shop" stands in "shop's" as renameAll's pattern reads it.
    expect(standsIn("shop", words)).toBe(true);
    expect(standsIn("hop", words)).toBe(false);
    expect(standsIn("Shop's license", words)).toBe(false);
    expect(standsIn("barbershop", words)).toBe(false);
    expect(standsIn("license. a", words)).toBe(false);
    expect(standsIn("Shops", words)).toBe(true);
    // A swap's first side that ends with a space or a mark needs no word edge there (swapRes); a rename's does.
    const row = wordsOf(["Skin fade, Sat 10am"]);
    expect(standsIn("Skin fade, ", row)).toBe(false);
    expect(standsIn("Skin fade, ", row, true)).toBe(true);
    expect(standsIn("Skin fade", row, true)).toBe(true);
    expect(standsIn("Skin fad", row, true)).toBe(false);
    expect(standsIn("", row, true)).toBe(false);
  });

  it("finds where a first side was meant to rename by the words in a row it shares with a line", () => {
    expect(sharedRun("Thanks. The state licenses the shop.", "The state licenses plumbing.")).toBe(3);
    expect(
      meantFor(
        "Means 'Doesn't match': the lookup has no license with that number.",
        "the lookup has no license with that number and name",
      ),
    ).toBe(true);
    expect(meantFor("Rosie checks the shop.", "Rosie checks the van.")).toBe(false);
    const lines: ReadLine[] = [
      { step: "S1-01", field: "does", text: "Nothing alike here." },
      { step: "S1-02", field: "more[0]", text: "Rosie checks the license on the state's lookup." },
    ];
    expect(placeOf("Rosie checks the license on the city's lookup.", lines)).toStrictEqual({
      line: lines[1],
      run: 6,
      claim: true,
    });
    expect(placeOf("Zebras dance at noon.", lines)).toStrictEqual({ line: null, run: 0, claim: false });
    // Fewer than RUN words in a row is no place: "the license on" alone is not where a first side was meant to rename.
    expect(placeOf("Sam keeps the license on file for the owner.", lines).line).toBeNull();
  });

  it("reads a check claim while verify is off, but not a sentence that holds only with checks on or says they are off", () => {
    expect(claimsWhileOff("Rosie checks the license on the state's lookup.")).toBe(true);
    expect(claimsWhileOff("Everyone's licenses are confirmed on the state's lookup.")).toBe(true);
    // The master's own S2-11 line: C7's phrases read a claim in it, but it holds only with checks on.
    const s211 =
      "License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date.";
    expect(holdsClaim(s211)).toBe(true);
    expect(claimsWhileOff(s211)).toBe(false);
    expect(
      claimsWhileOff(
        "Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name.",
      ),
    ).toBe(false);
    expect(
      claimsWhileOff(
        "License checks are off for now (D96). Rosie's team checks the license within 1 business day.",
      ),
    ).toBe(true);
  });
});

describe("the first-side lint (T-1439)", () => {
  it("lists a made-up pair that matches nothing, and not a pair that matches master text, as a rename and as a swap", () => {
    const raw = JSON.parse(tradeText("vehicle-wrap")) as {
      rename: { A: [string, string][] };
      A: { ops: unknown[] };
    };
    raw.rename.A.unshift(
      ["Lee's Barbershop", "Lee Wraps"],
      ["A moon license, checked on the lunar lookup.", "Made up."],
    );
    raw.A.ops.push({
      op: "words",
      at: "S1-01",
      vary: {
        "pf:sensitive": {
          swap: [
            ["Lee Wraps", "Lee Film"],
            ["Moonbeam lookup words", "Made up."],
          ],
        },
      },
    });
    const text = JSON.stringify(raw, null, 1);
    const trade = parseTrade(JSON.parse(text), "vehicle-wrap");
    const { findings } = firstSideFindings(master, [{ trade, text }]);
    const listed = (path: (string | number)[]): FirstSideFinding | undefined =>
      findings.find((one) => JSON.stringify(one.path) === JSON.stringify(path));
    // The master text pair renames the master's own words; the swap after it matches the words the pair laid.
    expect(listed(["rename", "A", 0])).toBeUndefined();
    const swaps = findings.filter((one) => one.kind === "swap");
    expect(swaps.map((one) => one.first)).toStrictEqual(["Moonbeam lookup words"]);
    const made = listed(["rename", "A", 1]);
    expect(made?.reason).toBe("no source found");
    expect(made?.first).toBe("A moon license, checked on the lunar lookup.");
    const lines = text.split("\n");
    expect(lines[(made?.lines[0] ?? 0) - 1]).toContain("A moon license, checked on the lunar lookup.");
    expect(lines[(made?.lines[1] ?? 0) - 1]).toContain("Made up.");
    expect(made?.line).toBe(
      `vehicle-wrap.json:${String(made?.lines[0])}-${String(made?.lines[1])} A rename[1]: ${REASONS["no source found"]}`,
    );
    const swap = swaps[0];
    expect(swap?.at).toBe("S1-01");
    expect(swap?.line).toMatch(
      /^vehicle-wrap\.json:\d+-\d+ A ops\[\d+\]\.vary\['pf:sensitive'\]\.swap\[1\]: /,
    );
  });

  it("lists the card's known members today, each with its file, lines and reason", () => {
    // vehicle-wrap.json:413-414 and window-tint.json:440-441: a first side that 7 trade files hold, and no master file.
    const barber = "Thanks. The state licenses the shop and each barber. What's the shop's license number?";
    expect(at("vehicle-wrap.json", 413)?.line).toBe(
      "vehicle-wrap.json:413-414 A rename[7]: a copy of another trade's first side",
    );
    expect(at("window-tint.json", 440)?.line).toBe(
      "window-tint.json:440-441 A rename[18]: a copy of another trade's first side",
    );
    const holders = report()
      .findings.filter((one) => one.first === barber)
      .map((one) => one.line);
    expect(holders).toStrictEqual([
      "golf-instructor.json:367-368 A rename[0]: a copy of another trade's first side",
      "gunsmith.json:496-497 A rename[25]: a copy of another trade's first side",
      "ski-instructor.json:348-349 A rename[0]: a copy of another trade's first side",
      "sports-coach.json:352-353 A rename[0]: a copy of another trade's first side",
      "vehicle-inspection.json:509-510 A rename[39]: a copy of another trade's first side",
      "vehicle-wrap.json:413-414 A rename[7]: a copy of another trade's first side",
      "window-tint.json:440-441 A rename[18]: a copy of another trade's first side",
    ]);
    // "Everyone's licenses are confirmed on the state's lookup." (11 trade files) and "... on the official lookup." (6):
    // 17 trade files (band.json:1029, interior.json:745, security.json:412 and yoga.json:1994 among them), and no
    // master file holds "licenses are confirmed on the".
    for (const file of ["master-A.json", "master-B.json"])
      expect(readFileSync(`${MASTER_DIR}${file}`, "utf8")).not.toContain("licenses are confirmed on the");
    const confirmed = report()
      .findings.filter((one) => one.first.startsWith("Everyone's licenses are confirmed on the "))
      .map((one) => one.line);
    expect(confirmed).toStrictEqual([
      "band.json:1029-1030 A rename[164]: a copy of another trade's first side",
      "band.json:4003-4004 B rename[398]: a copy of another trade's first side",
      "clown.json:1010-1011 A rename[162]: a copy of another trade's first side",
      "clown.json:3960-3961 B rename[400]: a copy of another trade's first side",
      "comedian.json:1008-1009 A rename[162]: a copy of another trade's first side",
      "comedian.json:3994-3995 B rename[400]: a copy of another trade's first side",
      "dance.json:1777-1778 A rename[364]: a copy of another trade's first side",
      "dance.json:4447-4448 B rename[421]: a copy of another trade's first side",
      "dj.json:1052-1053 A rename[160]: a copy of another trade's first side",
      "dj.json:3946-3947 B rename[394]: a copy of another trade's first side",
      "doula.json:1255-1256 B rename[47]: a copy of another trade's first side",
      "interior.json:745-746 A rename[102]: no master line, other flow, own new side or other trade's pair found",
      "interior.json:3107-3108 B rename[414]: no master line, other flow, own new side or other trade's pair found",
      "lactation.json:1229-1230 B rename[45]: a copy of another trade's first side",
      "laundry.json:1060-1061 B rename[7]: a copy of another trade's first side",
      "midwife.json:1270-1271 B rename[44]: a copy of another trade's first side",
      "party-characters.json:1012-1013 A rename[162]: a copy of another trade's first side",
      "party-characters.json:3982-3983 B rename[400]: a copy of another trade's first side",
      "pet-sitter.json:664-665 A rename[98]: a copy of another trade's first side",
      "pet-sitter.json:2678-2679 B rename[149]: a copy of another trade's first side",
      "photographer.json:906-907 A rename[124]: a copy of another trade's first side",
      "photographer.json:3388-3389 B rename[258]: a copy of another trade's first side",
      "security.json:412-413 A rename[20]: a copy of another trade's first side",
      "security.json:3570-3571 B rename[20]: a copy of another trade's first side",
      "shoe-repair.json:1118-1119 B rename[21]: a copy of another trade's first side",
      "upholstery.json:1136-1137 B rename[23]: a copy of another trade's first side",
      "yoga.json:1994-1995 A rename[412]: a copy of another trade's first side",
      "yoga.json:4596-4597 B rename[428]: a copy of another trade's first side",
    ]);
    expect(
      new Set(
        report()
          .findings.filter((one) => confirmed.includes(one.line))
          .map((one) => one.trade),
      ).size,
    ).toBe(17);
  });

  it("pins today's list by place, with its counts and where each pair was meant to rename: it reports, and nothing it finds stops the build", async () => {
    const { pairs, unlisted, findings } = report();
    const byReason: Record<string, number> = {};
    for (const one of findings) byReason[one.reason] = (byReason[one.reason] ?? 0) + 1;
    // Each listed pair's place on the master's own flow, while verify is off (masterPlaces): a master line it shares
    // the most words in a row with, or none.
    const places = masterPlaces(master, findings);
    const meant = {
      "no line": places.filter((one) => one.line === null).length,
      "a line with no claim": places.filter((one) => one.line !== null && !one.claim).length,
      "a line with a claim": places.filter((one) => one.claim).length,
    };
    expect({
      pairs,
      unlisted,
      listed: findings.length,
      files: new Set(findings.map((one) => one.trade)).size,
      byReason,
      meant,
    }).toMatchInlineSnapshot(`
      {
        "byReason": {
          "dead new side": 124,
          "no source found": 2749,
          "other flow": 7172,
          "other trade's new side": 260,
          "other trade's pair": 18110,
          "slot": 153,
        },
        "files": 234,
        "listed": 28568,
        "meant": {
          "a line with a claim": 0,
          "a line with no claim": 3770,
          "no line": 24798,
        },
        "pairs": {
          "rename": 112389,
          "swap": 0,
        },
        "unlisted": {
          "own ops": 12,
          "shadowed": 3684,
        },
      }
    `);
    // Each line: a trade file, a flow and a kind, then each listed pair's first side line and its reason's letter (s a
    // slot, o the other flow, d a dead new side, p another trade's first side, n another trade's new side, x none found),
    // then where it was meant to rename on the master's flow: nothing for no line, + a line that claims no check made
    // while verify is off, ! one that does.
    await expect(placesText(findings, places)).toMatchFileSnapshot("./first-sides.places.txt");
    // No listed pair was meant for a master line that claims a check made while verify is off.
    expect(findings.filter((_, k) => places[k]?.claim === true).map((one) => one.line)).toStrictEqual([]);
    // The renames not listed whose first side matches the trade's own ops' words alone (renames run before the ops, so
    // they rename nothing either; c7.test.ts keeps them out of FIRST_SIDES), by place.
    const ownOps = report().ownOps.map(
      (one) => `${one.trade}.json:${String(one.lines[0])} ${one.flow} rename[${String(one.path[2])}]`,
    );
    expect(ownOps).toHaveLength(unlisted["own ops"]);
    expect(ownOps).toMatchInlineSnapshot(`
      [
        "band.json:2423 B rename[3]",
        "carpet.json:1836 B rename[239]",
        "carpet.json:1840 B rename[240]",
        "carpet.json:1844 B rename[241]",
        "orthopedist.json:787 B rename[10]",
        "restoration.json:1544 A rename[305]",
        "security.json:6502 B rename[753]",
        "security.json:6506 B rename[754]",
        "senior-living.json:608 A rename[98]",
        "senior-living.json:1114 B rename[104]",
        "senior-living.json:1122 B rename[106]",
        "senior-living.json:1130 B rename[108]",
      ]
    `);
    // A pair placed on a master line that holds a check claim at all (S1-32's and S2-11's, which hold only with checks on
    // or say checks are off now) is meant for that claim line, so pairsAtClaimLines reads it again on its trade's
    // compiled flow (the next test).
    const claims = { A: masterClaimLines(master, "A"), B: masterClaimLines(master, "B") };
    const placedOnClaims = findings.filter((_, k) => {
      const line = places[k]?.line;
      return line !== undefined && line !== null && holdsClaim(line.text);
    });
    expect(placedOnClaims.length).toBeGreaterThan(0);
    for (const one of placedOnClaims)
      expect(
        claims[one.flow].some((line) => meantFor(one.first, line.text)),
        one.line,
      ).toBe(true);
  });

  it("reads what a person reads, by compiling, where a listed pair was meant for one of the master's own claim lines", () => {
    // The master's own lines that hold a check claim by READ_PATTERNS and that a person may read while verify is off.
    const claims = { A: masterClaimLines(master, "A"), B: masterClaimLines(master, "B") };
    expect(claims).toMatchInlineSnapshot(`
      {
        "A": [
          {
            "field": "more[2]",
            "step": "S1-32",
            "text": "Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name.",
          },
          {
            "field": "does",
            "step": "S2-11",
            "text": "License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date.",
          },
          {
            "field": "more[1]",
            "step": "S2-11",
            "text": "With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day.",
          },
          {
            "field": "more[3]",
            "step": "S2-11",
            "text": "Means 'Doesn't match' (checks on only): the lookup has no license with that number and name.",
          },
          {
            "field": "more[4]",
            "step": "S11-52",
            "text": "An owner of record can claim a business set up by someone who isn't one. Rosie's team checks the papers first.",
          },
        ],
        "B": [
          {
            "field": "more[2]",
            "step": "S1-32",
            "text": "Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name.",
          },
          {
            "field": "does",
            "step": "S2-11",
            "text": "License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date.",
          },
          {
            "field": "more[1]",
            "step": "S2-11",
            "text": "With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day.",
          },
          {
            "field": "more[3]",
            "step": "S2-11",
            "text": "Means 'Doesn't match' (checks on only): the lookup has no license with that number and name.",
          },
          {
            "field": "more[4]",
            "step": "S11-52",
            "text": "An owner of record can claim a business set up by someone who isn't one. Rosie's team checks the papers first.",
          },
        ],
      }
    `);
    // Of them, only S11-52's (an owner of record's papers, which no listed pair is meant for) claims a check while verify
    // is off; S1-32's and S2-11's say they hold only with checks on, or that checks are off now.
    expect(
      [...claims.A, ...claims.B].filter((line) => claimsWhileOff(line.text)).map((line) => line.step),
    ).toStrictEqual(["S11-52", "S11-52"]);
    const trades = new Map(loaded().map(({ trade }) => [trade.id, trade]));
    const meant = pairsAtClaimLines(master, report().findings, trades);
    expect(
      meant.map(
        (one) =>
          `${one.finding.line} | meant for ${one.line.step} ${one.line.field} | reads: ${String(one.reads)} | claim: ${String(one.claim)}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "band.json:945-946 A rename[143]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "band.json:945-946 A rename[143]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "band.json:949-950 A rename[144]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "band.json:949-950 A rename[144]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "band.json:3863-3864 B rename[363]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "band.json:3863-3864 B rename[363]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "band.json:3867-3868 B rename[364]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "band.json:3867-3868 B rename[364]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "clown.json:926-927 A rename[141]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "clown.json:926-927 A rename[141]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "clown.json:930-931 A rename[142]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "clown.json:930-931 A rename[142]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "clown.json:3816-3817 B rename[364]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "clown.json:3816-3817 B rename[364]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "clown.json:3820-3821 B rename[365]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "clown.json:3820-3821 B rename[365]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "comedian.json:924-925 A rename[141]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "comedian.json:924-925 A rename[141]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "comedian.json:928-929 A rename[142]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "comedian.json:928-929 A rename[142]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "comedian.json:3850-3851 B rename[364]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "comedian.json:3850-3851 B rename[364]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "comedian.json:3854-3855 B rename[365]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "comedian.json:3854-3855 B rename[365]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "dance.json:1809-1810 A rename[372]: no master line, other flow, own new side or other trade's pair found | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dance.json:1809-1810 A rename[372]: no master line, other flow, own new side or other trade's pair found | meant for S2-11 more[3] | reads: null | claim: false",
        "dance.json:4479-4480 B rename[429]: no master line, other flow, own new side or other trade's pair found | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dance.json:4479-4480 B rename[429]: no master line, other flow, own new side or other trade's pair found | meant for S2-11 more[3] | reads: null | claim: false",
        "dj.json:968-969 A rename[139]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dj.json:968-969 A rename[139]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "dj.json:972-973 A rename[140]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dj.json:972-973 A rename[140]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "dj.json:3806-3807 B rename[359]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dj.json:3806-3807 B rename[359]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "dj.json:3810-3811 B rename[360]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "dj.json:3810-3811 B rename[360]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "hair-restoration.json:1591-1592 B rename[15]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "hair-restoration.json:1631-1632 B rename[25]: a copy of another trade's first side | meant for S2-11 does | reads: License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date. | claim: false",
        "hair-restoration.json:1639-1640 B rename[27]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "hair-restoration.json:1651-1652 B rename[30]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "hair-restoration.json:1651-1652 B rename[30]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "interior.json:3071-3072 B rename[405]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "interior.json:3071-3072 B rename[405]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "interior.json:3075-3076 B rename[406]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "interior.json:3075-3076 B rename[406]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "iv-hydration.json:1627-1628 B rename[16]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "iv-hydration.json:1667-1668 B rename[26]: a copy of another trade's first side | meant for S2-11 does | reads: License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date. | claim: false",
        "iv-hydration.json:1675-1676 B rename[28]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "iv-hydration.json:1687-1688 B rename[31]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "iv-hydration.json:1687-1688 B rename[31]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "party-characters.json:928-929 A rename[141]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "party-characters.json:928-929 A rename[141]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "party-characters.json:932-933 A rename[142]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "party-characters.json:932-933 A rename[142]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "party-characters.json:3838-3839 B rename[364]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "party-characters.json:3838-3839 B rename[364]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "party-characters.json:3842-3843 B rename[365]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "party-characters.json:3842-3843 B rename[365]: a copy of another trade's first side | meant for S2-11 more[3] | reads: null | claim: false",
        "photographer.json:810-811 A rename[100]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "photographer.json:810-811 A rename[100]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "photographer.json:814-815 A rename[101]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "photographer.json:814-815 A rename[101]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "photographer.json:3220-3221 B rename[216]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "photographer.json:3220-3221 B rename[216]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "photographer.json:3224-3225 B rename[217]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "photographer.json:3224-3225 B rename[217]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "plastic-surgeon.json:1621-1622 B rename[15]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "plastic-surgeon.json:1661-1662 B rename[25]: a copy of another trade's first side | meant for S2-11 does | reads: License checks are off for now (D96). Each license stays as the person added it, never checked. With checks on, Rosie checks the name, kind, status, places and end date. | claim: false",
        "plastic-surgeon.json:1669-1670 B rename[27]: a copy of another trade's first side | meant for S2-11 more[1] | reads: With checks on, where a lookup has no data feed, a person on Rosie's team checks within 1 business day. | claim: false",
        "plastic-surgeon.json:1681-1682 B rename[30]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "plastic-surgeon.json:1681-1682 B rename[30]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "restoration.json:812-813 A rename[122]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "restoration.json:812-813 A rename[122]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "restoration.json:816-817 A rename[123]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "restoration.json:816-817 A rename[123]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "restoration.json:3290-3291 B rename[410]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "restoration.json:3290-3291 B rename[410]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "restoration.json:3294-3295 B rename[411]: a copy of another trade's first side | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "restoration.json:3294-3295 B rename[411]: a copy of another trade's first side | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "yoga.json:2026-2027 A rename[420]: no master line, other flow, own new side or other trade's pair found | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "yoga.json:2026-2027 A rename[420]: no master line, other flow, own new side or other trade's pair found | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
        "yoga.json:4628-4629 B rename[436]: no master line, other flow, own new side or other trade's pair found | meant for S1-32 more[2] | reads: Means 'The number isn't found' (license checks only; off now): the lookup has no license with that number and name. | claim: false",
        "yoga.json:4628-4629 B rename[436]: no master line, other flow, own new side or other trade's pair found | meant for S2-11 more[3] | reads: Means 'Doesn't match' (checks on only): the lookup has no license with that number and name. | claim: false",
      ]
    `);
    // At each of these places a person reads the master's own line, which claims no check made while verify is off: the
    // corrections layer has nothing to change there.
    expect(meant.filter((one) => one.claim)).toStrictEqual([]);
  });

  it("reads what a person reads, by compiling, where the card's known members were meant to rename", () => {
    const trades = new Map(loaded().map(({ trade }) => [trade.id, trade]));
    const known = report().findings.filter(
      (one) =>
        one.first ===
          "Thanks. The state licenses the shop and each barber. What's the shop's license number?" ||
        one.first.startsWith("Everyone's licenses are confirmed on the "),
    );
    const compiled = new Map<string, ReadLine[]>();
    const read = known.map((one) => {
      const key = `${one.trade} ${one.flow}`;
      let lines = compiled.get(key);
      if (lines === undefined) {
        const trade = trades.get(one.trade);
        if (trade === undefined) throw new Error(`${one.file} was not loaded`);
        lines = compiledLines(master, trade, one.flow);
        compiled.set(key, lines);
      }
      const place = placeOf(one.first, lines);
      const where =
        place.line === null
          ? "no line"
          : `${place.line.step} ${place.line.field} (${String(place.run)} words)`;
      return {
        line: `${one.line} | first side claims: ${String(holdsClaim(one.first))} | new side claims: ${String(holdsClaim(one.second))} | meant for ${where} | reads: ${place.line?.text ?? "nothing"}`,
        claim: place.claim,
      };
    });
    expect(read.map((one) => one.line)).toMatchInlineSnapshot(`
      [
        "band.json:1029-1030 A rename[164]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "band.json:4003-4004 B rename[398]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "clown.json:1010-1011 A rename[162]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "clown.json:3960-3961 B rename[400]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "comedian.json:1008-1009 A rename[162]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "comedian.json:3994-3995 B rename[400]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "dance.json:1777-1778 A rename[364]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "dance.json:4447-4448 B rename[421]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "dj.json:1052-1053 A rename[160]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "dj.json:3946-3947 B rename[394]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "doula.json:1255-1256 B rename[47]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "golf-instructor.json:367-368 A rename[0]: a copy of another trade's first side | first side claims: false | new side claims: false | meant for no line | reads: nothing",
        "gunsmith.json:496-497 A rename[25]: a copy of another trade's first side | first side claims: false | new side claims: false | meant for no line | reads: nothing",
        "interior.json:745-746 A rename[102]: no master line, other flow, own new side or other trade's pair found | first side claims: true | new side claims: false | meant for S2-22 q (5 words) | reads: Let them take bookings now?",
        "interior.json:3107-3108 B rename[414]: no master line, other flow, own new side or other trade's pair found | first side claims: true | new side claims: false | meant for S2-22 q (5 words) | reads: Let them take bookings now?",
        "lactation.json:1229-1230 B rename[45]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "laundry.json:1060-1061 B rename[7]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for S2-22 say[0][2] (8 words) | reads: Everyone's set up. Each person is who you say: you confirm it. Let them take bookings now?",
        "midwife.json:1270-1271 B rename[44]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "party-characters.json:1012-1013 A rename[162]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "party-characters.json:3982-3983 B rename[400]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "pet-sitter.json:664-665 A rename[98]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "pet-sitter.json:2678-2679 B rename[149]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "photographer.json:906-907 A rename[124]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "photographer.json:3388-3389 B rename[258]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "security.json:412-413 A rename[20]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "security.json:3570-3571 B rename[20]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "shoe-repair.json:1118-1119 B rename[21]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for S2-22 say[0][2] (8 words) | reads: Everyone's set up. Each person is who you say: you confirm it. Let them take bookings now?",
        "ski-instructor.json:348-349 A rename[0]: a copy of another trade's first side | first side claims: false | new side claims: false | meant for no line | reads: nothing",
        "sports-coach.json:352-353 A rename[0]: a copy of another trade's first side | first side claims: false | new side claims: false | meant for no line | reads: nothing",
        "upholstery.json:1136-1137 B rename[23]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for S2-22 say[0][2] (8 words) | reads: Everyone's set up. Each person is who you say: you confirm it. Let them take bookings now?",
        "vehicle-inspection.json:509-510 A rename[39]: a copy of another trade's first side | first side claims: false | new side claims: false | meant for no line | reads: nothing",
        "vehicle-wrap.json:413-414 A rename[7]: a copy of another trade's first side | first side claims: false | new side claims: true | meant for no line | reads: nothing",
        "window-tint.json:440-441 A rename[18]: a copy of another trade's first side | first side claims: false | new side claims: true | meant for no line | reads: nothing",
        "yoga.json:1994-1995 A rename[412]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
        "yoga.json:4596-4597 B rename[428]: a copy of another trade's first side | first side claims: true | new side claims: false | meant for no line | reads: nothing",
      ]
    `);
    expect(read.filter((one) => one.claim)).toStrictEqual([]);
    // On each of these compiled flows, a person reads no check claim but the master's own claim lines.
    const masterTexts = new Set(
      [...masterClaimLines(master, "A"), ...masterClaimLines(master, "B")].map((line) => line.text),
    );
    const other: string[] = [];
    for (const [key, lines] of compiled)
      for (const line of lines)
        if (holdsClaim(line.text) && !masterTexts.has(line.text))
          other.push(`${key} ${line.step} ${line.field}: ${line.text}`);
    expect(other).toStrictEqual([]);
  });
});
