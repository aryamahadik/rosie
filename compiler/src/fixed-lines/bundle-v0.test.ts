// T-1146's third check: T-314's fixed-line inserter (actions/src/finalize/fixed-lines) on the rebuilt bundle v0, its
// lists as bundles/v0/bundle/manifest.json packs them for a pinned turn. Rosie's first text to a handle about a business
// gets the opener before the words, then optOutLine, then privacyLink alone on the last line, with every message check
// passing, and lineNotInBundle no longer occurs: the same first text on K-01 v1's sample list, which bundle v0 carried
// before, is refused whole.
//
// The row and the send-state facts are T-314's own doubles (actions/src/finalize/fixed-lines/test-support.ts: T-313's
// A7-17 row, Lee's Barbershop's text to Alex M.; a first text, nothing texted before and no opt-out line delivered), with
// bundle v0's lists in place of their stand-in lists. The inserter, the slot filler, the claim check and the message
// checks run for real, alone and through the finalize call on T-313's fake repo. Values are the master's sample cast
// (rule 9).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMessageChecks, type CheckLists } from "../../../actions/src/finalize/checks";
import { fixedLineWords } from "../../../actions/src/finalize/checks/reading";
import {
  FIRST_TEXT_LINES,
  FixedLineRefusedError,
  insertFixedLines,
} from "../../../actions/src/finalize/fixed-lines";
import {
  FIRST_TEXT,
  OPENER,
  factsPort,
  firstTextRow,
  partsOf,
  repoWithInserter,
  wordsSend,
} from "../../../actions/src/finalize/fixed-lines/test-support";
import type { FinalParts, FinalizeRequest, FinalizeResponse } from "../../../actions/src/finalize/rewrite";
import {
  bundleLists,
  exchange,
  runFinalize,
  type CallRun,
} from "../../../actions/src/finalize/rewrite/test-support";
import { buildFixedLines, readBasePath, type FixedLines } from "./index";

/** Bundle v0's manifest as bundles/v0 publishes it: what a turn pinned to v0 reads first (K-01 v1 manifest). */
interface V0Manifest {
  bundleId: { hash: string; build: number };
  partial?: boolean;
  lists: { keywords: { optOut: string[] }; fixedLines: FixedLines };
}

const V0 = JSON.parse(
  readFileSync(new URL("../../../bundles/v0/bundle/manifest.json", import.meta.url), "utf8"),
) as V0Manifest;

/** The lists the message checks and the inserter read from the pinned bundle (K-01 v1 sharedLists). */
const V0_LISTS: CheckLists = { keywords: V0.lists.keywords, fixedLines: V0.lists.fixedLines };

/** Bundle v0's words for a fixed line, in a language. */
function v0Words(id: string, lang = "en"): string {
  const text = V0.lists.fixedLines.lines.find((line) => line.id === id && line.lang === lang)?.text;
  if (text === undefined || text === null) throw new Error(`bundle v0 has no words for ${id} in ${lang}`);
  return text;
}

/** Bundle v0's opener for Lee's Barbershop, <business> filled as the inserter fills it. */
const OPENER_V0 = v0Words("opener").replace("<business>", "Lee's Barbershop");

const REWRITE = exchange("finalize-rewrite.json");

/** A7-17's composed plan, put so that every check passes: Riley can't be in on Saturday (T-314's own). */
function passingPlan(): FinalizeRequest {
  const base = REWRITE.request;
  return {
    ...base,
    plan: {
      ...base.plan,
      plan: {
        ...base.plan.plan,
        formats: ["text"],
        lines: [{ role: "first", text: "{{pro.name}} can't be in on {{day}}." }],
        question: null,
      },
    },
  };
}

/** The words the composed plan fills to, as rewrite/parts.ts builds them (T-310's filler). */
const COMPOSED = "Riley can't be in on Sat Oct 24.";

/** The answer as a K-09 v1 response; fails the test when it is an error or a base refusal. */
function responseOf(run: CallRun): FinalizeResponse {
  expect(run.answer, JSON.stringify(run.answer)).toHaveProperty("outcome");
  return run.answer as FinalizeResponse;
}

/** The words send's text of some parts. */
const wordsOf = (parts: FinalParts | null | undefined): string | null | undefined =>
  parts?.sends.find((send) => send.kind === "words")?.text;

describe("bundle v0 packs the fixed-lines module's list for staging", () => {
  it("its lists.fixedLines are buildFixedLines() for wrangler.jsonc's staging BASE_PATH, privacyLink among them", () => {
    expect(V0.partial).toBe(true);
    expect(V0.lists.fixedLines).toEqual(buildFixedLines({ basePath: readBasePath("staging") }));
    expect(v0Words("privacyLink")).toBe("Privacy notice: rosfield.com/test/privacy");
    const privacy = V0.lists.fixedLines.lines.find((line) => line.id === "privacyLink");
    expect(privacy?.status).toBe("asWritten");
    expect(privacy?.source).toMatch(/^Q-30's default, for Jay to confirm before production/);
  });

  it("holds words for each line a first text carries, in English, and optOutLine in Spanish", () => {
    for (const id of FIRST_TEXT_LINES) {
      expect(fixedLineWords(id, { ...firstTextRow({}, { lists: V0_LISTS }).checks }), id).toHaveProperty(
        "words",
      );
    }
    expect(OPENER_V0).toBe(OPENER);
    expect(v0Words("optOutLine", "es")).toMatch(/^Responda STOP para no recibir más\./);
  });
});

describe("a first text through T-314's inserter on bundle v0: the opener, optOutLine, then privacyLink alone last", () => {
  it("the inserter alone: the three lines in that order, word for word as bundle v0 writes them, every check passing", () => {
    const row = firstTextRow({}, { lists: V0_LISTS });
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, FIRST_TEXT);

    const lines = wordsOf(added)?.split("\n");
    expect(lines).toEqual([`${OPENER_V0} ${COMPOSED}`, v0Words("optOutLine"), v0Words("privacyLink")]);
    expect(lines?.at(-1)).toBe("Privacy notice: rosfield.com/test/privacy");
    expect(added.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("through the finalize call: the first text is written with the three lines and every check passed", async () => {
    const port = factsPort(FIRST_TEXT);
    const { repo, ports } = repoWithInserter(firstTextRow({}, { lists: V0_LISTS }), port);
    const sent = responseOf(await runFinalize(passingPlan(), ports));

    expect(sent.outcome).toBe("send");
    expect(sent.checks[0].checks.every((check) => check.passed)).toBe(true);
    expect(wordsOf(sent.finalParts)).toBe(
      `${OPENER_V0} ${COMPOSED}\n${v0Words("optOutLine")}\n${v0Words("privacyLink")}`,
    );
    expect(sent.finalParts?.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([sent.finalParts]);
    expect(port.reads).toEqual(["outbox-a7-17-alex-text@biz-lees-barbershop"]);
  });

  it("a Spanish handle's first text carries bundle v0's Spanish optOutLine, the opener and the link in English", async () => {
    const row = firstTextRow({}, { lists: V0_LISTS, language: "es" });
    const { ports } = repoWithInserter(row, factsPort(FIRST_TEXT));
    const sent = responseOf(await runFinalize(passingPlan(), ports));

    expect(sent.outcome).toBe("send");
    expect(wordsOf(sent.finalParts)).toBe(
      `${OPENER_V0} ${COMPOSED}\n${v0Words("optOutLine", "es")}\n${v0Words("privacyLink")}`,
    );
    expect(sent.checks[0].checks.find((check) => check.check === "fixedLines")?.passed).toBe(true);
  });
});

describe("lineNotInBundle no longer occurs", () => {
  it("K-01 v1's sample list, which bundle v0 carried before, refuses the first text whole; bundle v0 now carries it", async () => {
    const parts = partsOf([wordsSend(COMPOSED)]);
    const before = firstTextRow({}, { lists: bundleLists() });
    expect(() => insertFixedLines(parts, before, FIRST_TEXT)).toThrow(/lineNotInBundle: privacyLink/);
    const refused = repoWithInserter(before, factsPort(FIRST_TEXT));
    await expect(runFinalize(passingPlan(), refused.ports)).rejects.toThrow(FixedLineRefusedError);
    expect(refused.repo.calls.writes).toEqual([]);

    const now = firstTextRow({}, { lists: V0_LISTS });
    expect(() => insertFixedLines(parts, now, FIRST_TEXT)).not.toThrow();
    for (const language of ["en", "es"]) {
      const row = firstTextRow({}, { lists: V0_LISTS, language });
      const { ports } = repoWithInserter(row, factsPort(FIRST_TEXT));
      expect(responseOf(await runFinalize(passingPlan(), ports)).outcome, language).toBe("send");
    }
  });
});
