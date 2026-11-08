// T-141, the stop-first lines per Q-30 (SPEC-master 5j; RULES 4.1b, 4.3, 1.11; S13-01, S13-02, S13-32; MC C9).
// Proofs of the card that belong to stops.ts:
//   - the master has 53 stop: "first" markers in flow A and 54 in flow B;
//   - on every money path of the corrected flows (barber, the master's words, both flows), the opt-out line renders
//     only on Rosie's first reply in a chat the person opened: `true` where it is that on every walk, "first" where it
//     depends on the walk, and never on a text to a chat nobody opened or on a later reply;
//   - every number that opens its chat on a path gets the line on Rosie's first reply there, the reply S13-01's opener
//     rides (S13-01 says so after C9), and the rendered text carries the opt-out line word for word;
//   - settleStops() moves the line by the walk's record, whether or not the master marked the message.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter, Message } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { plainText } from "../msgtext";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { tradePaths } from "../path";
import { FIRST_REPLY_LINES } from "./c9";
import { applyCorrections } from "./framework";
import { placedStops, settleStops, stopFor, walkStops, type ChatText } from "./stops";

vi.setConfig({ testTimeout: 300_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];

const fixedLines = JSON.parse(
  readFileSync(new URL("../../../contracts/bundle/fixtures/fixed-lines.json", import.meta.url), "utf8"),
) as { lines: { id: string; text: string | null }[] };
const OPT_OUT = fixedLines.lines.find((line) => line.id === "optOutLine")?.text ?? "";

type Line = readonly unknown[];

function rec(fields: Partial<ChatText>): ChatText {
  return { to: "staff", unopened: false, first: false, later: false, stop: null, ...fields };
}

describe("settleStops: the line by the walk's record", () => {
  const step = {
    id: "S9-01",
    say: [
      ["san", "staff", "first writer", { stop: "first", as: "Kim" }],
      ["staff", "san", "hello", { as: "Kim" }],
      ["san", "staff", "first reply", { as: "Kim" }],
      ["san", "staff", "later reply", { stop: true, as: "Kim" }],
      ["san", "staff", "first on some walks"],
    ],
  } as unknown as AppliedStep;

  it("puts the line on the first reply, takes it off a first writer and a later reply, and keeps 'first' where it depends", () => {
    const settled = settleStops(step, {
      0: rec({ unopened: true, stop: "first" }),
      2: rec({ first: true }),
      3: rec({ later: true, stop: true }),
      4: rec({ first: true, later: true }),
    });
    const marks = (settled.say ?? []).map(
      (message) => (message as Line)[3] as { stop?: unknown } | undefined,
    );
    expect(marks.map((elements) => elements?.stop)).toStrictEqual([
      undefined,
      undefined,
      true,
      undefined,
      "first",
    ]);
    expect((settled.say?.[0] as Line)[3]).toStrictEqual({ as: "Kim" });
    expect(step.say?.[0]).toStrictEqual(["san", "staff", "first writer", { stop: "first", as: "Kim" }]);
  });

  it("gives a text no line when it is never a first reply, and the step as it is when nothing changes", () => {
    expect(stopFor(undefined)).toBeUndefined();
    expect(stopFor(rec({ unopened: true }))).toBeUndefined();
    expect(stopFor(rec({ first: true }))).toBe(true);
    expect(stopFor(rec({ first: true, unopened: true }))).toBe("first");
    const plain = { id: "S9-02", say: [["san", "owner", "hi"]] } as unknown as AppliedStep;
    expect(settleStops(plain, undefined)).toBe(plain);
  });
});

describe('the stop: "first" markers per Q-30', () => {
  it("counts 53 markers in flow A and 54 in flow B", () => {
    const counts = FLOWS.map((flow) => {
      let n = 0;
      for (const step of Object.values(master[flow].steps)) {
        const lists: Line[][] = [step.say ?? []];
        for (const patch of Object.values(step.vary ?? {})) {
          const words = patch as { say?: Line[]; addSay?: Line[] };
          lists.push(words.say ?? [], words.addSay ?? []);
        }
        for (const list of lists)
          for (const message of list)
            if ((message[3] as { stop?: unknown } | undefined)?.stop === "first") n += 1;
      }
      return n;
    });
    expect(counts).toStrictEqual([53, 54]);
  });

  it("renders the line only on Rosie's first reply in an opened chat, on every money path of both corrected flows", () => {
    const trade = loadTrade("barber");
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], trade));
      const paths = tradePaths(done, trade, { booking: false, fixtures: false });
      expect(paths.length).toBeGreaterThan(0);
      let rendered = 0;
      for (const path of paths) {
        const walk = walkStops(done, path);
        const where = `${flow} ${path.price}|${path.before}|${path.after}`;
        const placed = placedStops(walk);
        for (const mark of placed) {
          const text = walk.texts[mark.step]?.[mark.index];
          expect(text?.first, `${where} ${mark.step} say[${String(mark.index)}]`).toBe(true);
          if (mark.stop === true) {
            expect(text?.later, `${where} ${mark.step}: a later reply`).toBe(false);
            expect(text?.unopened, `${where} ${mark.step}: a chat nobody opened`).toBe(false);
          }
        }
        // Every number with a first reply on the path gets the line there, and nothing else carries it.
        const firsts = new Set<string>();
        for (const [id, byIndex] of Object.entries(walk.texts))
          for (const [index, text] of Object.entries(byIndex)) if (text.first) firsts.add(`${id} ${index}`);
        expect(new Set(placed.map((mark) => `${mark.step} ${String(mark.index)}`))).toStrictEqual(firsts);
        // The rendered words carry the opt-out line word for word.
        for (const mark of placed.filter((one) => one.stop === true)) {
          const message = walk.steps.find((entry) => entry.id === mark.step)?.words.say?.[mark.index];
          expect(plainText(message as unknown as Message), where).toContain(OPT_OUT);
          rendered += 1;
        }
      }
      expect(rendered, `${flow}: the line renders somewhere`).toBeGreaterThan(0);
    }
  });

  it("puts the line on staff's first reply after their ready text, not on an invite (S2-05, S2-06)", () => {
    const trade = loadTrade("barber");
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], trade));
      const path = tradePaths(done, trade, { booking: false, fixtures: false })[0];
      if (path === undefined) throw new Error(`${flow}: no path`);
      const placed = placedStops(walkStops(done, path));
      expect(placed.some((mark) => mark.step === "S2-05")).toBe(false);
      expect(placed.some((mark) => mark.step === "S2-06" && mark.to.startsWith("staff"))).toBe(true);
    }
  });

  it("says in S13-01 that the opener, the opt-out line and the privacy link ride that first reply", () => {
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], loadTrade("barber")));
      const more = done.flow.steps.find((step) => step.id === "S13-01")?.more ?? [];
      for (const line of FIRST_REPLY_LINES) expect(more).toContain(line);
    }
  });
});
