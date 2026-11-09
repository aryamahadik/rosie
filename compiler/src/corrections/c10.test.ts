// T-141, C10: the owner's ID is an upload, accepted as given. Proofs of the card that belong to C10 (barber, aba and
// deck, both flows):
//   - S1-10 has no selfie, face-match or video lines, in its words, its secure page's card and form, and on the path;
//   - S1-10 asks for a photo or file of an ID document, accepted as given;
//   - S1-32's branch for an ID that doesn't match is off, so no path reaches S1-52 (and before C10 one does);
//   - S1-77 asks for the owner's own ID upload;
//   - every changed line carries MC:C10, in a step of the card.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import {
  FACE_OR_VIDEO,
  ID_ACCEPTED_OFF,
  ID_UPLOAD_CARD_LINE,
  ID_UPLOAD_FIELD,
  ID_UPLOAD_LINES,
  c10,
} from "./c10";
import { applyCorrections, renderDiff, type CorrectedTrade } from "./framework";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const TRADES = ["barber", "aba", "deck"] as const;
const C10_STEPS = ["S1-10", "S1-32", "S1-77"];

const memo = new Map<string, { applied: AppliedTrade; done: CorrectedTrade; only: CorrectedTrade }>();
function corrected(
  id: string,
  flow: FlowLetter,
): { applied: AppliedTrade; done: CorrectedTrade; only: CorrectedTrade } {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    const applied = applyTrade(master[flow], loadTrade(id));
    hit = { applied, done: applyCorrections(applied), only: applyCorrections(applied, [c10]) };
    memo.set(key, hit);
  }
  return hit;
}

function find(steps: AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = find(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

describe("C10: the owner's ID is an upload accepted as given", () => {
  it("leaves S1-10 no selfie, face-match or video line, in its words, its card and its form", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const step = find(corrected(trade, flow).done.flow.steps, "S1-10");
        const words = strings([step?.title, step?.does, step?.more, step?.say, step?.rule, step?.vary]);
        expect(
          words.filter((text) => FACE_OR_VIDEO.test(text)),
          `${trade} ${flow}`,
        ).toStrictEqual([]);
        expect(words.join(" ")).not.toMatch(/face match|selfie|video/i);
      }
  });

  it("shows S1-10 with no such line on every money path of the trade", () => {
    for (const flow of FLOWS) {
      const { done } = corrected("barber", flow);
      for (const path of tradePaths(done, loadTrade("barber"), { booking: false, fixtures: false })) {
        const lit = walkPath(done, path).steps.find((entry) => entry.id === "S1-10");
        expect(lit, `${flow}: S1-10 is lit`).toBeDefined();
        expect(strings(lit?.words).filter((text) => FACE_OR_VIDEO.test(text))).toStrictEqual([]);
      }
    }
  });

  it("asks for a photo or file of an ID document on the secure page, accepted as given", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const step = find(corrected(trade, flow).done.flow.steps, "S1-10");
        expect(step?.more, `${trade} ${flow}`).toContain(ID_UPLOAD_LINES[0]);
        const page = ((step?.say ?? []) as unknown[][]).find(
          (message) =>
            message[0] === "san" && (message[3] as { form?: unknown } | undefined)?.form !== undefined,
        );
        const elements = page?.[3] as { form?: string[]; card?: { lines?: string[] } } | undefined;
        expect(elements?.form, `${trade} ${flow}`).toContain(ID_UPLOAD_FIELD);
        expect(elements?.card?.lines, `${trade} ${flow}`).toContain(ID_UPLOAD_CARD_LINE);
        expect(step?.does).toContain("accepted as given");
        expect(step?.gives).toContain("id_checked");
      }
  });

  it("switches off S1-32's branch for an ID that doesn't match, so no path reaches S1-52 (before C10 one does)", () => {
    for (const flow of FLOWS) {
      const { applied, done } = corrected("barber", flow);
      const trade = loadTrade("barber");
      const branch = find(done.flow.steps, "S1-32")?.branches?.find(
        (one) => one.label === "The ID doesn't match",
      );
      expect(branch?.off).toBe(ID_ACCEPTED_OFF);
      const confirmed = find(done.flow.steps, "S1-32")?.branches?.find(
        (one) => one.label === "Confirmed in minutes",
      );
      expect(confirmed?.off).toBeUndefined();
      const before = tradePaths(applied, trade, { booking: false, fixtures: false }).some((path) =>
        walkPath(applied, path).steps.some((entry) => entry.id === "S1-52"),
      );
      expect(before, `${flow}: S1-52 is lit before C10`).toBe(true);
      for (const path of tradePaths(done, trade, { booking: false, fixtures: false }))
        expect(walkPath(done, path).steps.map((entry) => entry.id)).not.toContain("S1-52");
      expect(strings(find(done.flow.steps, "S1-32")?.more).join(" ")).not.toContain("selfie");
    }
  });

  it("asks S1-77's owner for their own ID upload", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const step = find(corrected(trade, flow).done.flow.steps, "S1-77");
        const words = strings([step?.does, step?.more, step?.say]).join(" ");
        expect(words, `${trade} ${flow}`).toContain("Upload your ID and confirm here.");
        expect(words, `${trade} ${flow}`).not.toMatch(/ID check/);
      }
  });
});

describe("C10 on the whole", () => {
  it("changes only the steps of the card, and every changed line carries MC:C10", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { only } = corrected(trade, flow);
        expect(only.changes.length).toBeGreaterThan(0);
        for (const change of only.changes) {
          expect(change.tag).toBe("MC:C10");
          expect(C10_STEPS, `${trade} ${flow}: ${change.step}`).toContain(change.step);
        }
        expect(renderDiff(only.changes).every((line) => line.startsWith("MC:C10 "))).toBe(true);
      }
  });

  it("finds nothing more to change in a flow it has already corrected", () => {
    for (const flow of FLOWS)
      expect(applyCorrections(corrected("barber", flow).done, [c10]).changes).toStrictEqual([]);
  });
});
