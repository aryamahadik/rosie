// T-141, C9: no SMS, and Rosie never writes first. Proofs of the card that belong to C9 (barber has the master's words;
// aba and deck rename the business; both flows each):
//   - no compiled message says it goes by SMS;
//   - no Rosie text in C9's steps goes to a number that has not texted in, on every money path of the trade (and before
//     C9 some does, so the check can fail);
//   - S2-05 has no invite text: the owner gets each person's link and QR, and the person's ready text is their yes;
//     S2-07 texts nobody but the owner and gives the link again;
//   - S1-10 and S13-45 ask the person to text from that mobile (S13-45: or by email for a booking with one);
//   - S1-77's owner and S1-78's contact send their own text before Rosie's first text to them;
//   - A6-14 and B6-13 carry the link again for a chat never opened; S13-01 says the first text of a thread is Rosie's
//     first reply in a chat the person opened;
//   - every changed line carries MC:C9, in a step of the card.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths } from "../path";
import { c1 } from "./c1";
import { c2 } from "./c2";
import {
  ASK_FROM_MOBILE,
  C9_STEPS,
  CODE_BY_EMAIL,
  CODE_FROM_MOBILE,
  FIRST_REPLY_LINES,
  JOIN_LINKS_TEXT,
  NEVER_OPENED,
  READY_TEXT_JOINS,
  c9,
} from "./c9";
import { applyCorrections, renderDiff, type CorrectedTrade } from "./framework";
import { chatTexts } from "./stops";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const TRADES = ["barber", "aba", "deck"] as const;
const CONFIRM: Record<FlowLetter, string> = { A: "A6-14", B: "B6-13" };

type Line = readonly unknown[];

interface Done {
  applied: AppliedTrade;
  /** C1 and C2 only: the flow as it was before C9. */
  before: CorrectedTrade;
  /** C1, C2 and C9. */
  done: CorrectedTrade;
  /** C9 alone, for its own tags. */
  only: CorrectedTrade;
}

const memo = new Map<string, Done>();
function corrected(id: string, flow: FlowLetter): Done {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    const applied = applyTrade(master[flow], loadTrade(id));
    hit = {
      applied,
      before: applyCorrections(applied, [c1, c2]),
      done: applyCorrections(applied, [c1, c2, c9]),
      only: applyCorrections(applied, [c9]),
    };
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

function sayOf(done: CorrectedTrade, id: string): Line[] {
  return find(done.flow.steps, id)?.say ?? [];
}

function moreOf(done: CorrectedTrade, id: string): string[] {
  return find(done.flow.steps, id)?.more ?? [];
}

/** Every message of every step: each step's say and each variant's say and addSay, branch steps included. */
function allMessages(steps: AppliedStep[], out: Line[] = []): Line[] {
  for (const step of steps) {
    for (const message of step.say ?? []) out.push(message as Line);
    for (const patch of Object.values(step.vary ?? {})) {
      const words = patch as { say?: Line[]; addSay?: Line[] };
      out.push(...(words.say ?? []), ...(words.addSay ?? []));
    }
    for (const branch of step.branches ?? []) allMessages(branch.steps, out);
  }
  return out;
}

const LANES_WITH_A_NUMBER = ["cust", "owner", "staff", "other"];

describe("C9: no SMS", () => {
  it("leaves no compiled message that says it goes by SMS", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const said = allMessages(corrected(trade, flow).done.flow.steps)
          .flatMap((message) => strings(message))
          .filter((text) => /\bSMS\b/i.test(text));
        expect(said, `${trade} ${flow}`).toStrictEqual([]);
      }
  });
});

describe("C9: Rosie never writes first", () => {
  it("texts no number in C9's steps before it texts Rosie, on every money path (and before C9 S2-05, S2-07, S1-77, S1-78 and S1-10 each do)", () => {
    // The walk keys each chat by its person (DL-211), so it sees S1-77's text to the real owner and S1-10's secure ID
    // check to the mobile, which CQ-123 (1) proved only by message order inside the step.
    const walked = ["S2-05", "S2-06", "S2-07", "S1-77", "S1-78", "S1-10"];
    for (const flow of FLOWS) {
      const { before, done } = corrected("barber", flow);
      const trade = loadTrade("barber");
      const paths = tradePaths(done, trade, { booking: false, fixtures: false });
      expect(paths.length).toBeGreaterThan(0);
      const wroteFirst = new Set<string>();
      for (const path of tradePaths(before, trade, { booking: false, fixtures: false })) {
        const texts = chatTexts(before, path);
        for (const id of walked)
          if (Object.values(texts[id] ?? {}).some((rec) => rec.unopened)) wroteFirst.add(id);
      }
      expect([...wroteFirst].sort(), `${flow}: before C9 these steps of the card text first`).toStrictEqual([
        "S1-10",
        "S1-77",
        "S1-78",
        "S2-05",
        "S2-07",
      ]);
      for (const path of paths) {
        const texts = chatTexts(done, path);
        for (const id of walked)
          for (const [index, rec] of Object.entries(texts[id] ?? {}))
            expect(
              rec.unopened,
              `${flow} ${path.price}|${path.before}|${path.after} ${id} say[${index}] to ${rec.to}`,
            ).toBe(false);
      }
    }
  });

  it("sends no invite in S2-05: the owner gets each person's link and QR, and the ready text is the yes to join", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { applied, done } = corrected(trade, flow);
        const invites = ((find(applied.flow.steps, "S2-05")?.say ?? []) as Line[]).filter(
          (message) =>
            message[0] === "san" && (message[3] as { stop?: unknown } | undefined)?.stop === "first",
        );
        expect(invites.length, `${trade} ${flow}: the master's invites`).toBeGreaterThan(0);
        const say = sayOf(done, "S2-05");
        for (const message of say)
          if (message[0] === "san") expect(message[1], `${trade} ${flow} S2-05`).toBe("owner");
        const links = say.find((message) => message[2] === JOIN_LINKS_TEXT);
        const lines = (links?.[3] as { card?: { lines?: string[] } } | undefined)?.card?.lines ?? [];
        expect(lines, `${trade} ${flow}: one link per person`).toHaveLength(invites.length);
        expect(lines.every((line) => line.endsWith(": own link and QR"))).toBe(true);
        const step = find(done.flow.steps, "S2-05");
        expect(step?.tells ?? []).not.toContain("staff");
        expect(strings([step?.title, step?.does, step?.more]).join(" ")).not.toMatch(
          /Invites go|one invite to each/,
        );
        expect(moreOf(done, "S2-06")).toContain(READY_TEXT_JOINS);
      }
    expect(find(corrected("barber", "A").done.flow.steps, "S2-05")?.title).toBe(
      "Gives the owner each person's join link",
    );
  });

  it("texts nobody but the owner in S2-07, and gives the owner the link again", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const say = sayOf(corrected(trade, flow).done, "S2-07");
        for (const message of say)
          if (message[0] === "san") expect(message[1], `${trade} ${flow} S2-07`).toBe("owner");
      }
    const owner = sayOf(corrected("barber", "A").done, "S2-07").find((message) => message[1] === "owner");
    expect(owner?.[2]).toBe(
      "Avery hasn't texted from their link yet. Here it is again, with its QR, to pass on.",
    );
    expect(strings(owner)).toContain("Avery: own link and QR");
  });

  it("makes S1-10 and S13-45 ask the person to text from that mobile, with no code texted to prove the phone", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { done } = corrected(trade, flow);
        const say = sayOf(done, "S1-10");
        const ask = say.findIndex((message) => message[2] === ASK_FROM_MOBILE);
        const page = say.findIndex((message) => message[0] === "san" && message[3] !== undefined);
        expect(ask, `${trade} ${flow}: S1-10 asks for a text from that mobile`).toBeGreaterThanOrEqual(0);
        expect(
          page,
          `${trade} ${flow}: the secure page comes after the text from that mobile`,
        ).toBeGreaterThan(ask + 1);
        expect(say[ask + 1]?.[0]).toBe("owner");
        expect(
          strings(say).some((text) => /prove (?:this|the) phone/i.test(text) && /code/i.test(text)),
        ).toBe(false);
        expect(moreOf(done, "S13-45")).toContain(CODE_FROM_MOBILE);
        expect(moreOf(done, "S13-45")).toContain(CODE_BY_EMAIL);
      }
    expect(find(corrected("barber", "A").done.flow.steps, "S1-10")?.does).toContain(
      "asks them to text Rosie from it. That text proves the phone",
    );
  });

  it("has S1-77's owner and S1-78's contact text Rosie before Rosie's first text to them", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { done } = corrected(trade, flow);
        const owner = sayOf(done, "S1-77");
        const toOwner = owner.findIndex(
          (message) =>
            message[0] === "san" &&
            message[1] === "owner" &&
            /confirm/i.test(strings(message).join(" ")) &&
            (message[3] as { as?: unknown } | undefined)?.as === undefined,
        );
        const fromOwner = owner.findIndex(
          (message) =>
            message[0] === "owner" &&
            message[1] === "san" &&
            (message[3] as { as?: unknown } | undefined)?.as === undefined,
        );
        expect(fromOwner, `${trade} ${flow} S1-77`).toBeGreaterThanOrEqual(0);
        expect(fromOwner, `${trade} ${flow} S1-77`).toBeLessThan(toOwner);
        const contact = sayOf(done, "S1-78");
        const toContact = contact.findIndex((message) => message[0] === "san" && message[1] === "other");
        const fromContact = contact.findIndex((message) => message[0] === "other" && message[1] === "san");
        expect(fromContact, `${trade} ${flow} S1-78`).toBeGreaterThanOrEqual(0);
        expect(fromContact, `${trade} ${flow} S1-78`).toBeLessThan(toContact);
      }
  });

  it("carries the link again on a confirmation whose chat was never opened, and says where the first text goes", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { done } = corrected(trade, flow);
        expect(moreOf(done, CONFIRM[flow]), `${trade} ${CONFIRM[flow]}`).toContain(NEVER_OPENED);
        for (const line of FIRST_REPLY_LINES) expect(moreOf(done, "S13-01")).toContain(line);
      }
  });
});

describe("C9 on the whole", () => {
  it("changes only the steps of the card, and every changed line carries MC:C9", () => {
    for (const trade of TRADES)
      for (const flow of FLOWS) {
        const { only } = corrected(trade, flow);
        expect(only.changes.length).toBeGreaterThan(0);
        for (const change of only.changes) {
          expect(change.tag).toBe("MC:C9");
          expect(C9_STEPS[flow], `${trade} ${flow}: ${change.step}`).toContain(change.step);
        }
        expect(renderDiff(only.changes).every((line) => line.startsWith("MC:C9 "))).toBe(true);
      }
  });

  it("finds nothing more to change in a flow it has already corrected", () => {
    for (const flow of FLOWS)
      expect(applyCorrections(corrected("barber", flow).done, [c9]).changes).toStrictEqual([]);
  });

  it("leaves every Rosie message to a lane with a number in S2-05 and S2-07 for the owner alone", () => {
    for (const flow of FLOWS)
      for (const id of ["S2-05", "S2-07"])
        for (const message of sayOf(corrected("barber", flow).done, id))
          if (message[0] === "san" && LANES_WITH_A_NUMBER.includes(String(message[1])))
            expect(message[1]).toBe("owner");
  });
});
