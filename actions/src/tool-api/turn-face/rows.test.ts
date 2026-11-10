// T-1141's unit proof of the turn face's compose input and finalize (K-09 v1 compose-input-s1-02.json and
// finalize-pass.json, on S1-02's row outbox-s1-02-sam-1), through the Tool API base with T-309's compose input, T-313's
// finalize and T-314's fixed-line inserter as built, the two readRow ports and the fixed lines' facts bound by rows.ts
// over K-05 v1.3's own answers (read-outbox-row-s1-02.json, fixed-line-facts-s1-02.json), and the turn's words handed in
// by the runtime through gateAndCommit (held.ts). Nothing under test is stood in for; the bundles are K-01 v1's
// bundle-v0-skeleton.json, which the row pins, and bundle v0 as bundles/v0 publishes it with T-1146's privacyLink.

import { describe, expect, it } from "vitest";

import { FixedLineRefusedError } from "../../finalize/fixed-lines";
import type { BundleDocument } from "../../frontier/assemble/test-support";
import { contractFile, fixture, traceFor } from "../test-support";
import { createToolApiValidator } from "../validator";
import {
  READER_WAITING,
  commitRequestAfter,
  firstTextFacts,
  outboxRowS102,
  publishedBundleV0,
  rowCalls,
  rowDoubles,
  rowUnderPublishedV0,
  type RowDoubles,
} from "./calls-test-support";
import { NOTHING_OPEN_AT } from "./commit";
import { TurnFaceRefusedError } from "./errors";
import { addressedAs, safetyLinesFor, type OutboxRowRead } from "./rows";
import { createTurnFace, type TurnFace } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

const composeExchange = (): { request: Json; outcome: { input: Json } } =>
  fixture("compose-input-s1-02.json") as { request: Json; outcome: { input: Json } };
const finalizeExchange = (): { request: Json } => fixture("finalize-pass.json") as { request: Json };

/** The face over the row doubles (its frontier is not called here). */
function faceOf(doubles: RowDoubles): TurnFace {
  return createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: doubles.binding.bundles,
    validator,
    calls: rowCalls(doubles),
  });
}

/** The face, after turn 1's gateAndCommit handed it the turn's words (commit-s1-01.json's request). */
async function faceAfterTurnOne(doubles: RowDoubles): Promise<TurnFace> {
  const face = faceOf(doubles);
  const request = commitRequestAfter(undefined);
  const committed = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(committed).toMatchObject({ result: "committed", turnId: "turn-s1-01-sam" });
  return face;
}

async function settle<T>(promise: Promise<T>): Promise<{ answer?: T; thrown?: unknown }> {
  return promise.then(
    (answer) => ({ answer }),
    (thrown: unknown) => ({ thrown }),
  );
}

/** The row read with a change, from K-05's read-outbox-row-s1-02.json. */
function rowWith(change: (row: OutboxRowRead) => OutboxRowRead): OutboxRowRead {
  return change(structuredClone(outboxRowS102()));
}

describe("compose input through the turn face on S1-02's row (K-05 v1.3 read-outbox-row-s1-02.json)", () => {
  it("gives compose-input-s1-02.json's input from the row, the bundle and the words the runtime handed in; gentle while the sensitive switch is treated as on (DL-326 note b)", async () => {
    const doubles = rowDoubles();
    const face = await faceAfterTurnOne(doubles);
    const { request, outcome } = composeExchange();
    const { trace, spans } = traceFor(request);
    const answer = await face.composeInput(structuredClone(request), trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toEqual({ result: "compose", input: { ...outcome.input, situation: "gentle" } });
    expect(doubles.reads).toEqual(["readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop"]);
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans)).not.toContain("Hi, I want to put my barbershop on Rosie");
  });

  it("gives no inbound text when the face was not handed the turn's words, nor in a reply to anyone but their sender", async () => {
    const { request, outcome } = composeExchange();
    const unheld = await faceOf(rowDoubles()).composeInput(structuredClone(request), traceFor(request).trace);
    expect(unheld).toMatchObject({ result: "compose", input: { inbound: null } });

    const toAnother = rowDoubles({
      row: rowWith((row) => ({ ...row, answers: { ...row.answers, handleId: "handle-alex" } })),
    });
    const answer = await (
      await faceAfterTurnOne(toAnother)
    ).composeInput(structuredClone(request), traceFor(request).trace);
    expect(answer).toMatchObject({ result: "compose", input: { inbound: null } });
    expect(outcome.input.inbound).not.toBeNull();
  });

  it("refuses the row of a recipient who holds no role yet, never guessing a reader (READER_WAITING)", async () => {
    expect(READER_WAITING).toHaveLength(1);
    const doubles = rowDoubles({
      row: rowWith((row) => ({ ...row, recipient: { ...row.recipient, roles: [] } })),
    });
    const { request } = composeExchange();
    const called = await settle(
      faceOf(doubles).composeInput(structuredClone(request), traceFor(request).trace),
    );
    expect(called.thrown).toBeInstanceOf(TurnFaceRefusedError);
    expect(called.thrown).toMatchObject({ fault: "noReader" });
  });

  it("answers K-05's notFound and transient as its own errors, and refuses a safety row and a row that asks nothing", async () => {
    const { request } = composeExchange();
    const call = (doubles: RowDoubles) =>
      settle(faceOf(doubles).composeInput(structuredClone(request), traceFor(request).trace));
    const notFound = { error: "notFound", table: "outbox_rows", rowId: "outbox-s1-02-sam-1" };
    expect((await call(rowDoubles({ row: notFound }))).answer).toEqual(notFound);
    const transient = { error: "transient", sqlstate: "40001" };
    expect((await call(rowDoubles({ row: transient }))).answer).toEqual(transient);
    const safetyRow = { error: "fixedLineRow", outboxRowId: "outbox-s1-02-sam-1", sendClass: "safety" };
    expect((await call(rowDoubles({ row: safetyRow }))).thrown).toMatchObject({ fault: "fixedLineRow" });
    const noLine = await call(rowDoubles({ row: rowWith((row) => ({ ...row, line: null })) }));
    expect(noLine.thrown).toMatchObject({ name: "TurnFaceRefusedError", fault: "noLine" });
  });

  it("answers notBuilt for a row about a booking, with options or with no business (default 7), reading nothing more", async () => {
    const { request } = composeExchange();
    const rows: OutboxRowRead[] = [
      rowWith((row) => ({ ...row, row: { ...row.row, bookingId: "booking-alex-haircut" } })),
      rowWith((row) => ({ ...row, slotSource: { ...row.slotSource, business: null } })),
      rowWith((row) => {
        const question = row.slotSource.question;
        if (question === null) throw new Error("S1-02's row asks its question");
        return {
          ...row,
          slotSource: {
            ...row.slotSource,
            question: { ...question, options: [{ id: "o-1", label: "1 Yes" }] },
          },
        };
      }),
    ];
    for (const row of rows) {
      const answer = await faceOf(rowDoubles({ row })).composeInput(
        structuredClone(request),
        traceFor(request).trace,
      );
      expect(answer).toEqual({ error: "notBuilt", call: "composeInput" });
    }
  });

  it("addresses the reader by the first word of the stored name", () => {
    expect(addressedAs("Sam Lee")).toBe("Sam");
    expect(addressedAs(null)).toBeNull();
    expect(addressedAs("  ")).toBeNull();
  });
});

describe("finalize through the turn face with finalize-pass.json's plan on S1-02's row", () => {
  /** finalize-pass.json's request through the face over the doubles: what it answered or threw. */
  async function finalizeOn(doubles: RowDoubles) {
    const { request } = finalizeExchange();
    return settle(faceOf(doubles).finalizeMessage(structuredClone(request), traceFor(request).trace));
  }

  it("on K-01's bundle-v0-skeleton.json, which holds no privacyLink, Rosie's first text is refused whole: lineNotInBundle (K-09 v1.5 open gap 121); nothing is written", async () => {
    const doubles = rowDoubles({ facts: firstTextFacts() });
    const called = await finalizeOn(doubles);
    expect(called.thrown).toBeInstanceOf(FixedLineRefusedError);
    expect(called.thrown).toMatchObject({ fault: "lineNotInBundle", line: "privacyLink" });
    expect(doubles.plans).toEqual([]);
    expect(doubles.reads).toEqual([
      "readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop",
      "readFixedLineFacts outbox-s1-02-sam-1@biz-lees-barbershop",
    ]);
  });

  it("on bundle v0 as published with the line (T-1146), the final parts carry its opener, the opt-out line and the privacy link (Q-30), written with the plan", async () => {
    const bundle: BundleDocument = publishedBundleV0();
    const doubles = rowDoubles({ row: rowUnderPublishedV0(), facts: firstTextFacts(), bundle });
    const called = await finalizeOn(doubles);
    expect(called.thrown).toBeUndefined();
    const answer = called.answer as unknown as Json & {
      checks: { checked: Json & { fixedLines: string[] } }[];
    };
    expect(validator.check("finalizeMessage", "response", answer)).toEqual([]);
    const [first] = answer.checks;
    expect(first?.checked.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    const lines = ((first?.checked.sends as { text: string }[] | undefined)?.[0]?.text ?? "").split("\n");
    const fixed = (
      bundle.manifest.lists as { fixedLines: { lines: { id: string; lang: string; text: string }[] } }
    ).fixedLines.lines;
    const words = (id: string): string =>
      fixed.find((line) => line.id === id && line.lang === "en")?.text ?? "";
    expect(lines[0]?.startsWith(words("opener").replace("<business>", "Lee's Barbershop"))).toBe(true);
    expect(lines.slice(-2)).toEqual([words("optOutLine"), words("privacyLink")]);
    expect(answer.outcome, JSON.stringify(answer.checks)).toBe("send");
    expect(doubles.plans.map((plan) => plan.finalParts)).toEqual([answer.finalParts]);
  });

  it("the opener names the business as limit 7 shows it: the display name, while the switch is treated as on (DL-326 note b)", async () => {
    const row = rowUnderPublishedV0(
      rowWith((each) => {
        const business = each.slotSource.business;
        if (business === null) throw new Error("the row names its business");
        return {
          ...each,
          slotSource: { ...each.slotSource, business: { ...business, displayName: "Lee's" } },
        };
      }),
    );
    const doubles = rowDoubles({ row, facts: firstTextFacts(), bundle: publishedBundleV0() });
    const called = await finalizeOn(doubles);
    const answer = called.answer as { checks: { checked: { sends: { text: string }[] } }[] };
    const text = answer.checks[0]?.checked.sends[0]?.text ?? "";
    expect(text.startsWith("This is Rosie, the automated booking assistant for Lee's.")).toBe(true);
    expect(text).not.toContain("Lee's Barbershop");
  });

  it("the row's other lines: a safety line only on the danger text's writer's row, never safetyAsk, which the inserter places (DL-355)", async () => {
    const answering = (outcomes: string[], tenses: string[], handleId = "handle-sam"): OutboxRowRead =>
      rowWith((row) => ({
        ...row,
        answers: { handleId, texts: [{ eventId: "evt-sam-s1-01", outcomes, tenses }] as never },
      }));
    expect(safetyLinesFor(answering(["No"], ["now"]))).toEqual([]);
    expect(safetyLinesFor(answering(["Crisis words"], ["now"]))).toEqual(["safetyCrisis"]);
    expect(safetyLinesFor(answering(["An emergency", "Unsure"], ["now", "unknown"]))).toEqual([
      "safetyEmergency",
      "safetyCrisis",
    ]);
    expect(safetyLinesFor(answering(["A threat to staff or others"], ["now"]))).toEqual([]);
    expect(safetyLinesFor(answering(["Crisis words"], ["now"], "handle-alex"))).toEqual([]);

    // Through finalize on the published bundle: the writer's crisis line, then the danger question the inserter adds for a
    // tense it does not know (T-1164), each once.
    const row = rowUnderPublishedV0(answering(["Crisis words"], ["unknown"]));
    const doubles = rowDoubles({ row, facts: firstTextFacts(), bundle: publishedBundleV0() });
    const called = await finalizeOn(doubles);
    const answer = called.answer as { checks: { checked: { fixedLines: string[] } }[] };
    expect(answer.checks[0]?.checked.fixedLines).toEqual([
      "opener",
      "safetyCrisis",
      "safetyAsk",
      "optOutLine",
      "privacyLink",
    ]);
  });

  it("finalize's row is K-05's: its version, its question with the clock row it withdraws, its step's terms and fallback", async () => {
    const answer = (
      contractFile("data-access/fixtures/read-outbox-row-s1-02.json") as { outcome: OutboxRowRead }
    ).outcome;
    expect(answer.slotSource.question?.clockRow?.id).toBe("clock-oq-s1-02-sam-1");
    const noClock = rowWith((row) => {
      const question = row.slotSource.question;
      if (question === null) throw new Error("S1-02's row asks its question");
      return { ...row, slotSource: { ...row.slotSource, question: { ...question, clockRow: null } } };
    });
    const called = await finalizeOn(rowDoubles({ row: noClock, facts: firstTextFacts() }));
    expect(called.thrown).toMatchObject({ name: "TurnFaceRefusedError", fault: "noClockRow" });
  });
});
