// T-1141's unit proof of the turn face's compose input and finalize (K-09 v1 compose-input-s1-02.json and
// finalize-pass.json, on S1-02's row outbox-s1-02-sam-1), through the Tool API base with T-309's compose input, T-313's
// finalize and T-314's fixed-line inserter as built, the two readRow ports and the fixed lines' facts bound by rows.ts
// over K-05 v1.3's own answers (read-outbox-row-s1-02.json, fixed-line-facts-s1-02.json), and the turn's words handed in
// by the runtime through gateAndCommit (held.ts). Nothing under test is stood in for; the bundles are K-01 v1's
// bundle-v0-skeleton.json, which the row pins, and bundle v0 as bundles/v0 publishes it with T-1146's privacyLink.
//
// Round 2 (DL-364, DL-370): the reader is K-05 v1.5's rowReader (README item 44), proven on its 3 accepted fixtures, its
// 2 refused ones, the three security cases (no person, lineTo null, a cust line: never read as the owner), the by-role
// branch, and turn 1's row as it runs, to Sam with no role, read as the owner and addressed as "Sam".

import { describe, expect, it } from "vitest";

import type { Role } from "../../domain/identity-access";
import { readerOf } from "../../finalize/claim-check";
import { FixedLineRefusedError } from "../../finalize/fixed-lines";
import { fakeBundles, sampleBundle, type BundleDocument } from "../../frontier/assemble/test-support";
import { contractFile, fixture, traceFor } from "../test-support";
import { createToolApiValidator } from "../validator";
import {
  ROW_READER_ACCEPTED,
  ROW_READER_REFUSED,
  bundleOfRequest,
  commitRequestAfter,
  firstTextFacts,
  outboxRowS102,
  outboxRowTurnOne,
  publishedBundleV0,
  readOfRequest,
  rowCalls,
  rowDoubles,
  rowReaderFixture,
  rowReaderProblems,
  rowUnderPublishedV0,
  type RowDoubles,
} from "./calls-test-support";
import { NOTHING_OPEN_AT } from "./commit";
import { TurnFaceRefusedError } from "./errors";
import { addressedAs, composeRowOf, lineToOf, readerOfRow, safetyLinesFor, type OutboxRowRead } from "./rows";
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

/** bundle-v0-skeleton.json (the row's pin) with its S1-02 changed, a test's own copy. */
function skeletonWithS102(change: (step: Json) => void): BundleDocument {
  const bundle = sampleBundle("bundle-v0-skeleton.json");
  const flow = bundle.flows.A as { steps: Record<string, Json | undefined> };
  const step = flow.steps["S1-02"];
  if (step === undefined) throw new Error("bundle v0 holds S1-02");
  change(step);
  return bundle;
}

/** S1-02 whose lines from Rosie go to these lanes, in say order: its own first line, once to each. */
function withSayTo(lanes: readonly string[]): BundleDocument {
  return skeletonWithS102((step) => {
    const say = step.say as Json[];
    const [first] = say;
    step.say = [...lanes.map((to) => ({ ...first, to })), ...say.slice(1)];
  });
}

/** S1-02 as a step of another section of its flow. */
function withSection(section: number): BundleDocument {
  return skeletonWithS102((step) => {
    step.section = section;
  });
}

/** The reader rows.ts maps for a read on a bundle (K-05 v1.5 item 44). */
async function readingOf(
  read: OutboxRowRead,
  bundle: BundleDocument = sampleBundle("bundle-v0-skeleton.json"),
) {
  return readerOfRow(fakeBundles(bundle), read);
}

/** The exchange a reading states: rowReader's call, a given, and the binding's own request and outcome. */
function exchangeOf(given: Json, request: unknown, outcome: unknown): Json {
  return { call: "rowReader", given, request, outcome };
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
    // DL-245: the bundle's S1-02 message carries the opt-out line in its plainText; the input never does, as only the
    // fixed-line inserter adds it.
    expect(JSON.stringify(answer)).not.toContain("Reply STOP to opt out");
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

  it("turn 1's row as it runs, to Sam who holds no role yet, gives the same input: read as the owner by S1-02's sign-up line (K-05 v1.5 item 44), addressed as Sam", async () => {
    const doubles = rowDoubles({ row: outboxRowTurnOne() });
    const face = await faceAfterTurnOne(doubles);
    const { request, outcome } = composeExchange();
    const answer = await face.composeInput(structuredClone(request), traceFor(request).trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toEqual({ result: "compose", input: { ...outcome.input, situation: "gentle" } });
    // Sam's stored name is "Sam Lee"; Rosie addresses him by its first word (default 4), as K-09's fixture does.
    expect(outboxRowTurnOne().recipient.name).toBe("Sam Lee");
    expect(answer).toMatchObject({ input: { audience: { role: "owner", name: "Sam" } } });
  });

  it("refuses a row no one reads, with rowReader's why: no person, a line to no reader, a step outside section 1, a role that reads as no one", async () => {
    const { request } = composeExchange();
    const refused = async (row: OutboxRowRead, bundle?: BundleDocument) => {
      const doubles = rowDoubles({ row, ...(bundle === undefined ? {} : { bundle }) });
      return (await settle(faceOf(doubles).composeInput(structuredClone(request), traceFor(request).trace)))
        .thrown;
    };
    const noRole = outboxRowTurnOne();
    const cases: { row: OutboxRowRead; bundle?: BundleDocument; why: string }[] = [
      { row: { ...noRole, recipient: { ...noRole.recipient, personId: null } }, why: "noRole" },
      { row: noRole, bundle: withSayTo(["owner", "cust"]), why: "lineHasNoReader" },
      { row: noRole, bundle: withSection(2), why: "noRole" },
      {
        row: rowWith((row) => ({
          ...row,
          recipient: {
            ...row.recipient,
            roles: [{ roleId: "role-sam-own", role: "own_business", version: 1 }],
          },
        })),
        why: "roleReadsAsNoOne",
      },
    ];
    for (const each of cases) {
      const thrown = await refused(each.row, each.bundle);
      expect(thrown).toBeInstanceOf(TurnFaceRefusedError);
      expect(thrown).toMatchObject({ fault: "noReader", why: each.why });
    }
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

describe("the reader, mapped exactly as K-05 v1.5's rowReader (README item 44; DL-370)", () => {
  it("the 3 accepted rowReader fixtures read as stated: from each request's read and its bundle, the binding builds the fixture's request and gives its outcome", async () => {
    for (const file of ROW_READER_ACCEPTED) {
      const exchange = rowReaderFixture(file);
      const { request, outcome } = await readerOfRow(
        bundleOfRequest(exchange.request),
        readOfRequest(exchange.request),
      );
      expect(request, file).toEqual(exchange.request);
      expect(outcome, file).toEqual(exchange.outcome);
      expect(outcome.outboxRowId, file).toBe(request.outboxRowId);
      expect(rowReaderProblems(exchangeOf(exchange.given, request, outcome)), file).toEqual([]);
    }
  });

  it("the 2 refused fixtures are never given: on each one's request the binding gives its accepted twin's outcome, and the schema refuses theirs", async () => {
    for (const { file, twin } of ROW_READER_REFUSED) {
      const refused = rowReaderFixture(`invalid/${file}`);
      expect(rowReaderProblems(refused), file).not.toEqual([]);
      const { outcome } = await readerOfRow(bundleOfRequest(refused.request), readOfRequest(refused.request));
      expect(outcome, file).not.toEqual(refused.outcome);
      expect(outcome, file).toEqual(rowReaderFixture(twin).outcome);
    }
  });

  it("the three security cases are refused: a row with no person, a line told as null, and a cust line are never read as the owner", async () => {
    const turnOne = outboxRowTurnOne();
    const given = rowReaderFixture("row-reader-s1-02-no-role.json").given;
    const asOwner = (request: unknown) =>
      exchangeOf(given, request, {
        result: "reader",
        outboxRowId: turnOne.outboxRowId,
        reader: "owner",
        from: "signUpLine",
        roleId: null,
      });

    // No person on the row (a bare handle): noReader noRole, on section 1 too (default 64).
    const noPerson = await readingOf({ ...turnOne, recipient: { ...turnOne.recipient, personId: null } });
    expect(noPerson.request.recipient).toEqual({ personId: null, roles: [] });
    expect(noPerson.outcome).toEqual({ error: "noReader", outboxRowId: turnOne.outboxRowId, why: "noRole" });

    // S1-02's lines from Rosie to two lanes: lineTo null, so the line is never told by a guess (default 62).
    const twoLanes = await readingOf(turnOne, withSayTo(["owner", "cust"]));
    expect(twoLanes.request.lineTo).toBeNull();
    expect(twoLanes.outcome).toEqual({
      error: "noReader",
      outboxRowId: turnOne.outboxRowId,
      why: "lineHasNoReader",
    });

    // A section 1 line to the customer: read as the customer, never as the owner.
    const custLine = await readingOf(turnOne, withSayTo(["cust"]));
    expect(custLine.request.lineTo).toBe("cust");
    expect(custLine.outcome).toEqual({
      result: "reader",
      outboxRowId: turnOne.outboxRowId,
      reader: "customer",
      from: "signUpLine",
      roleId: null,
    });

    for (const reading of [noPerson, twoLanes, custLine]) {
      expect(rowReaderProblems(exchangeOf(given, reading.request, reading.outcome))).toEqual([]);
      expect(rowReaderProblems(asOwner(reading.request))).not.toEqual([]);
      expect(reading.outcome.outboxRowId).toBe(reading.request.outboxRowId);
    }

    // A line to no reader lane (the customer's own AI, agent): lineHasNoReader; outside section 1: noRole, any lane.
    const toRosie = await readingOf(turnOne, withSayTo(["agent"]));
    expect(toRosie.outcome).toMatchObject({ error: "noReader", why: "lineHasNoReader" });
    const outside = await readingOf(turnOne, withSection(5));
    expect(outside.request).toMatchObject({ section: 5, lineTo: "owner" });
    expect(outside.outcome).toMatchObject({ error: "noReader", why: "noRole" });
  });

  it("the by-role branch ties the reader to readerOf(role) and the role id to one of the request's roles, never to the line", async () => {
    const withRoles = (roles: { roleId: string; role: Role; version: number }[]): OutboxRowRead =>
      rowWith((row) => ({ ...row, recipient: { ...row.recipient, roles } }));
    const given = rowReaderFixture("row-reader-s1-02-owner.json").given;
    const role = (roleId: string, held: Role) => ({ roleId, role: held, version: 1 });
    const cases: { roles: ReturnType<typeof role>[]; roleId: string | null }[] = [
      { roles: [role("role-sam-barber", "owner")], roleId: "role-sam-barber" },
      { roles: [role("role-sam-admin", "admin")], roleId: "role-sam-admin" },
      // The role the message is for (default 10): S1-02's line is to the owner, so the customer role is passed over.
      {
        roles: [role("role-a-customer", "customer"), role("role-b-owner", "owner")],
        roleId: "role-b-owner",
      },
      // No role the recipient holds reads S1-02's line: refused, never read by the line though it goes to the owner.
      { roles: [role("role-sam-staff", "staff")], roleId: null },
      { roles: [role("role-sam-own", "own_business")], roleId: null },
    ];
    for (const each of cases) {
      const { request, outcome } = await readingOf(withRoles(each.roles));
      expect(request.recipient.roles).toEqual(each.roles);
      expect(outcome.outboxRowId).toBe(request.outboxRowId);
      expect(rowReaderProblems(exchangeOf(given, request, outcome))).toEqual([]);
      if (each.roleId === null) {
        expect(outcome).toEqual({
          error: "noReader",
          outboxRowId: request.outboxRowId,
          why: "roleReadsAsNoOne",
        });
        continue;
      }
      if (!("result" in outcome) || outcome.from !== "roles") throw new Error("read by a role");
      const held = request.recipient.roles.find((one) => one.roleId === outcome.roleId);
      expect(outcome.roleId).toBe(each.roleId);
      expect(held).toBeDefined();
      expect(outcome.reader).toBe(readerOf(held?.role ?? "own_business"));
    }
  });

  it("the sign-up reading's role is never stored or handed on: compose input reads the owner, and the read's roles stay empty", async () => {
    const read = outboxRowTurnOne();
    const doubles = rowDoubles({ row: read });
    const row = await composeRowOf(doubles.binding, structuredClone(read));
    expect(row.role).toBe("owner");
    expect(row.name).toBe("Sam");
    expect(read.recipient.roles).toEqual([]);
    expect(doubles.plans).toEqual([]);
    // lineToOf alone: S1-02's one line from Rosie, to the owner, at index 0; none at index 1.
    const step = (sampleBundle("bundle-v0-skeleton.json").flows.A as { steps: Record<string, Json> }).steps[
      "S1-02"
    ];
    if (step === undefined) throw new Error("bundle v0 holds S1-02");
    expect(lineToOf(step, 0)).toBe("owner");
    expect(lineToOf(step, 1)).toBeNull();
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
