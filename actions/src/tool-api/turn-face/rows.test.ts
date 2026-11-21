// T-1141's unit proof of the turn face's compose input and finalize (K-09 v1 compose-input-s1-02.json and
// finalize-pass.json, on S1-02's row outbox-s1-02-sam-1), through the Tool API base with T-309's compose input, T-313's
// finalize and T-314's fixed-line inserter as built, the two readRow ports and the fixed lines' facts bound by rows.ts
// over K-05 v1.3's own answers (read-outbox-row-s1-02.json, fixed-line-facts-s1-02.json), and the turn's words handed in
// by the runtime through gateAndCommit (held.ts). Nothing under test is stood in for; the bundles are K-01 v1's
// bundle-v0-skeleton.json, which the row pins, and bundle v0 as bundles/v0 publishes it with T-1146's privacyLink.
//
// Round 2 (DL-364, DL-370): the reader is K-05 v1.5's rowReader (README item 44), proven on its 3 accepted fixtures, its
// 2 refused ones, the three security cases (no person, lineTo null, a cust line: never read as the owner), the by-role
// branch, and turn 1's row as it runs, to Sam with no role, read as the owner and addressed as "Sam". Since T-1174,
// compose input answers compose-input-s1-02.json's request as K-09 v1.6's compose-input-s1-02-v1.6.json states it
// (calls-test-support.ts composeS102).
//
// T-1193 (DL-376): the handle actor's turn records each row's fillAndChecks itself, so the face's compose input and
// finalize leave no span of the base's; the same handlers on a base called without the face's option give the same
// answers and record the base's one fillAndChecks span each, never the words.
//
// T-1190 (DL-391, DL-395, DL-402): the row read is K-05 v1.6's, and the sensitive switch is the business's own
// (businessSensitive, item 45) for a row about no booking: only false is off. So S1-02's row at the barbershop that holds
// its barber kind of work (read-outbox-row-s1-02-not-sensitive.json) gives compose-input-s1-02-v1.6.json's input word for
// word, routine, and the JOIN row gives T-1175's recording 4 request; null, the field left out and true are on (gentle,
// the display name); a row about a booking stays on; a read that fails is never read as on, off or null.
//
// T-1475 (DL-999, the S1-04 design ruling's card 6; K-05 v1.22 item 83): the row read is K-05 v1.22's, whose line may
// come from the row itself. read-outbox-row-s1-08-sam.json's answer (S1-08's row, which asks no question, its line `from`
// row) gives a compose row for S1-08, line 0, and a finalize row with question null and no ask-by, and it is read by the
// reader mapping as S1-02's row is; read-outbox-row-s1-02-older-row.json's answer (`from` openQuestion) reads as
// read-outbox-row-s1-02-no-kinds.json's does; a null line is still refused and a row whose question holds options is
// still notBuilt. The skeleton the fixtures pin lists S1-08 and holds only S1-01 and S1-02, so these tests read S1-08 in
// a copy of it that holds bundle v2's S1-08 (bundles/v2, T-1477: the master's step as compiled).

import { readdirSync, readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { addressedAs } from "../../compose-input";
import type { Role } from "../../domain/identity-access";
import { readerOf } from "../../finalize/claim-check";
import { FixedLineRefusedError } from "../../finalize/fixed-lines";
import { fakeBundles, sampleBundle, type BundleDocument } from "../../frontier/assemble/test-support";
import { contractFile, fixture, traceFor } from "../test-support";
import { createToolApi, type ToolApi } from "../tool-api";
import { createToolApiValidator } from "../validator";
import {
  ROW_READER_ACCEPTED,
  ROW_READER_REFUSED,
  bundleOfRequest,
  commitRequestAfter,
  composeS102,
  firstTextFacts,
  joinComposeInput,
  joinComposeRequest,
  joinHeldTurn,
  joinRow,
  outboxRowNoKinds,
  outboxRowS102,
  outboxRowSwitchLeftOut,
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
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";
import {
  composeRowOf,
  finalizeRowOf,
  lineToOf,
  readerOfRow,
  safetyLinesFor,
  sensitiveOf,
  type OutboxRowRead,
} from "./rows";
import { callHandlers, createTurnFace, type TurnFace } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

const composeExchange = (): { request: Json; outcome: { input: Json } } => composeS102();
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

/**
 * The face's own handlers for compose input and finalize over the doubles, on a base called as any other caller calls it:
 * without the face's option, so the base records each call's span (T-1193).
 */
function baseOf(doubles: RowDoubles): ToolApi {
  const calls = rowCalls(doubles);
  return createToolApi<unknown>({ validator, scope: calls.scope, handlers: callHandlers(calls, null) });
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

describe("compose input through the turn face on S1-02's row (K-05 v1.6 read-outbox-row-s1-02-not-sensitive.json)", () => {
  it("gives compose-input-s1-02-v1.6.json's input word for word from the row, the bundle and the words the runtime handed in: routine, the barbershop's switch off (T-1190)", async () => {
    const doubles = rowDoubles();
    const face = await faceAfterTurnOne(doubles);
    const { request, outcome } = composeExchange();
    const { trace, spans } = traceFor(request);
    const answer = await face.composeInput(structuredClone(request), trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(outboxRowS102().businessSensitive).toBe(false);
    expect(outcome.input.situation).toBe("routine");
    expect(answer).toEqual({ result: "compose", input: outcome.input });
    expect(doubles.reads).toEqual(["readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop"]);
    // No span of the base's: the turn records the row's fillAndChecks itself, and the face tells the base so (T-1193).
    // The base's own span, without the face's option and never with the words, is the next test's.
    expect(spans).toEqual([]);
    // DL-245: the bundle's S1-02 message carries the opt-out line in its plainText; the input never does, as only the
    // fixed-line inserter adds it.
    expect(JSON.stringify(answer)).not.toContain("Reply STOP to opt out");
  });

  it("without the face's option, the same handlers on the base give the same input and record its one fillAndChecks span, never the words the runtime handed in (T-1193)", async () => {
    const doubles = rowDoubles();
    const face = await faceAfterTurnOne(doubles);
    const { request } = composeExchange();
    const viaFace = traceFor(request);
    const answer = await face.composeInput(structuredClone(request), viaFace.trace);
    expect(viaFace.spans).toEqual([]);
    // A read: on the same doubles and the words the face holds, the base reads the row alike and answers the same.
    const { trace, spans } = traceFor(request);
    expect(await baseOf(doubles).call("composeInput", structuredClone(request), trace)).toEqual(answer);
    expect(JSON.stringify(answer)).toContain("Hi, I want to put my barbershop on Rosie");
    expect(doubles.reads).toEqual([
      "readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop",
      "readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop",
    ]);

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span).toMatchObject({
      hop: "fillAndChecks",
      trace_id: "trace-sam-0000",
      turn_id: "turn-s1-01-sam",
      outcome: "ok",
      got: { toolCall: "composeInput", callerKind: "turn" },
    });
    expect(validator.checkSpan(span)).toEqual([]);
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

  it("turn 1's row as it runs, to Sam who holds no role yet, gives the same input: read as the owner by S1-02's sign-up line (K-05 v1.5 item 44), addressed as Sam, routine at the seed's barbershop (T-1190)", async () => {
    const doubles = rowDoubles({ row: outboxRowTurnOne() });
    const face = await faceAfterTurnOne(doubles);
    const { request, outcome } = composeExchange();
    const answer = await face.composeInput(structuredClone(request), traceFor(request).trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toEqual({ result: "compose", input: outcome.input });
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

  it("addresses the reader by the first word of the stored name (default 4, compose input's since T-1174)", () => {
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
    // The name as the row read gives it; compose input addresses it by its first word (T-1174), "Sam".
    expect(row.name).toBe("Sam Lee");
    expect(addressedAs(row.name)).toBe("Sam");
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

describe("a row that carries its own line: K-05 v1.22's read (T-1475; README item 83; DL-999 card 6)", () => {
  /** S1-08's one line to the owner, word for word (MASTER-FLOW-A.md line 109; bundle v2's flow A, S1-08 say[0].text). */
  const PLAN_LINE = "Here's the plan. You can stop anytime: text MORE to pick up where you left off.";

  const CONTRACTS = new URL("../../../../contracts/", import.meta.url);
  const K05_V122 = "https://rosie.invalid/contracts/data-access/data-access.v1.22.schema.json";

  /** Every contract schema under contracts/ (Ajv 2020-12, strict, as contracts:check runs them), loaded once. */
  let schemas: Ajv2020 | undefined;

  /** The problems K-05 v1.22's `$defs/<definition>` finds in `value`; empty when accepted. */
  function v122Problems(definition: string, value: unknown): string[] {
    if (schemas === undefined) {
      schemas = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
      const files = readdirSync(CONTRACTS, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
        .filter((file) => !file.startsWith("generated") && !file.startsWith("scripts"))
        .filter((file) => !file.includes("node_modules"));
      for (const file of files) {
        schemas.addSchema(JSON.parse(readFileSync(new URL(file, CONTRACTS), "utf8")) as object);
      }
    }
    const validate = schemas.getSchema(`${K05_V122}#/$defs/${definition}`);
    if (validate === undefined) throw new Error(`K-05 v1.22 has no ${definition}`);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`.trim());
  }

  /** A K-05 readOutboxRow fixture's answer, freshly parsed, by its file name. */
  function k05Read(file: string): OutboxRowRead {
    return (contractFile(`data-access/fixtures/${file}`) as { outcome: OutboxRowRead }).outcome;
  }

  /**
   * K-05 v1.22's read-outbox-row-s1-08-sam.json answer: S1-08's row to Sam, the owner, which asks no question and holds
   * its own step and line, so its line is read from the row (item 83.1).
   */
  const outboxRowS108 = (): OutboxRowRead => k05Read("read-outbox-row-s1-08-sam.json");

  /**
   * K-05 v1.22's read-outbox-row-s1-02-older-row.json answer: turn 1's S1-02 row, written with neither column, so its
   * line is read from the question it asks, as v1.3 reads it (item 83.2).
   */
  const outboxRowOlder = (): OutboxRowRead => k05Read("read-outbox-row-s1-02-older-row.json");

  /**
   * bundle-v0-skeleton.json (the pin of both fixtures' rows), a test's own copy, holding S1-08 too, as bundle v2 holds it
   * (bundles/v2/bundle/flow/A.json, T-1477: the master's step as compiled), with a change when a test asks for one.
   */
  function skeletonWithS108(change: (step: Json) => void = () => undefined): BundleDocument {
    const bundle = sampleBundle("bundle-v0-skeleton.json");
    const v2 = JSON.parse(
      readFileSync(new URL("../../../../bundles/v2/bundle/flow/A.json", import.meta.url), "utf8"),
    ) as { steps: Record<string, Json | undefined> };
    const step = v2.steps["S1-08"];
    if (step === undefined) throw new Error("bundle v2 holds S1-08");
    change(step);
    (bundle.flows.A as { steps: Record<string, Json> }).steps["S1-08"] = step;
    return bundle;
  }

  /** S1-08's card lines that name no slot, in the card's order (bundle v2's S1-08 say[0].elements.card.lines). */
  const PLAN_TERMS = [
    "Your business and your ID: about 3 minutes",
    "Any license or document you want shown (optional)",
    "No extra agreement for your work",
    "Then the barbershop, live in about 15 minutes",
    "Then your people",
    "Nothing you tell me is asked twice",
  ];

  /** What limit 7 fills S1-08's row from: the business head alone, at the read's moment, with no ask-by. */
  const S108_SOURCE = {
    filledAt: "2026-10-19T18:20:04Z",
    zones: { visit: null, business: "America/New_York" },
    channel: "imessage",
    // businessSensitive null (no kinds of work stored): on (default 67).
    sensitive: true,
    record: null,
    facts: { business: { name: "Lee's Barbershop", displayName: "Lee's Barbershop" } },
  };

  /** A K-09 request of S1-02's fixtures, for S1-08's row and its turn. */
  function forS108(request: Json): Json {
    const turnId = outboxRowS108().row.turnId;
    return {
      ...request,
      caller: { ...(request.caller as Json), turnId, requestId: turnId },
      outboxRowId: outboxRowS108().outboxRowId,
    };
  }

  /** finalize-pass.json's request for S1-08's row, its plan S1-08's one line and no question. */
  function finalizeS108(): Json {
    const row = outboxRowS108().outboxRowId;
    return {
      ...forS108(finalizeExchange().request),
      plan: {
        row,
        channel: "imessage",
        copyOf: null,
        plan: {
          formats: ["text"],
          lines: [{ role: "first", text: PLAN_LINE }],
          question: null,
          pageType: null,
          threadReplyTo: null,
        },
      },
    };
  }

  it("read-outbox-row-s1-08-sam.json's answer, its line from the row and no question, gives a compose row for S1-08, line 0, with no ask-by", async () => {
    const read = outboxRowS108();
    expect(v122Problems("readOutboxRow.v1dot6Response", read)).toEqual([]);
    expect(read.line).toEqual({ step: "S1-08", index: 0, from: "row" });
    expect(read.row.openQuestionId).toBeNull();
    expect(read.slotSource.question).toBeNull();

    const doubles = rowDoubles({ row: read, bundle: skeletonWithS108() });
    const row = await composeRowOf(doubles.binding, structuredClone(read));
    expect(row).toEqual({
      outboxRowId: "out-s1-08-sam",
      turnId: "turn-s1-04-sam",
      state: "planned",
      hasPlan: false,
      channel: "imessage",
      copyOfRowId: null,
      fixedLineId: null,
      recipientHandleId: "handle-sam",
      bundleId: read.row.bundleId,
      flow: "A",
      step: "S1-08",
      line: 0,
      role: "owner",
      name: "Sam Lee",
      way: "texts",
      handlingLine: null,
      language: "en",
      source: S108_SOURCE,
      claim: {},
      factSlots: [],
      conversation: [],
      allowedFormats: ["text"],
      allowedLinks: [],
      options: [],
      openQuestions: [],
      inbound: null,
      situation: { safetyOutcomes: [], about: [] },
    });
    expect(row.source.facts).not.toHaveProperty("askBy");
    // Nothing is read but the row's own bundle, and nothing is written.
    expect(doubles.reads).toEqual([]);
    expect(doubles.plans).toEqual([]);
  });

  it("the same read gives a finalize row with question null and no ask-by: S1-08's step, its master line, its card's terms and its fallback", async () => {
    const read = outboxRowS108();
    const doubles = rowDoubles({ row: read, bundle: skeletonWithS108() });
    const row = await finalizeRowOf(doubles.binding, structuredClone(read));
    expect(row.question).toBeNull();
    expect(row.source).toEqual(S108_SOURCE);
    expect(row.source.facts).not.toHaveProperty("askBy");
    expect(row).toMatchObject({
      outboxRowId: "out-s1-08-sam",
      version: 1,
      state: "planned",
      channel: "imessage",
      finalParts: null,
      fixedLineId: null,
      step: "S1-08",
      reader: "owner",
      calendarFile: "none",
      fallbackText: PLAN_LINE,
    });
    expect(row.checks).toMatchObject({
      language: "en",
      // Under the switch (businessSensitive null: on), the business a fixed line names is its display name.
      businessName: "Lee's Barbershop",
      options: [],
      typedOptions: null,
      readerName: "Sam",
      masterText: PLAN_LINE,
      terms: PLAN_TERMS,
    });
  });

  it("through the face, S1-08's row reaches compose input: the input is S1-08's master line to Sam, the owner, with no open question", async () => {
    const doubles = rowDoubles({ row: outboxRowS108(), bundle: skeletonWithS108() });
    const request = forS108(composeExchange().request);
    const answer = await faceOf(doubles).composeInput(structuredClone(request), traceFor(request).trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toMatchObject({
      result: "compose",
      input: {
        row: "out-s1-08-sam",
        turn: "turn-s1-04-sam",
        masterText: { step: "S1-08", text: PLAN_LINE },
        audience: { role: "owner", name: "Sam", way: "texts" },
        channel: "imessage",
        situation: "gentle",
        options: [],
        openQuestions: [],
        inbound: null,
      },
    });
    const { facts } = (answer as unknown as { input: { facts: { value: string }[] } }).input;
    expect(facts.map((fact) => fact.value)).toEqual(PLAN_TERMS);
    expect(doubles.reads).toEqual(["readOutboxRow out-s1-08-sam@biz-lees-barbershop"]);
  });

  it("through the face, S1-08's row reaches finalize: its plan is checked and written with nothing to withdraw", async () => {
    // The two facts of a later text, as K-05's fixed-line-facts-texted-before.json answers them: an opener mark that
    // names an earlier row, and the opt-out line delivered. So no fixed line is added to this row.
    const textedBefore = (
      contractFile("data-access/fixtures/fixed-line-facts-texted-before.json") as {
        outcome: ReturnType<typeof firstTextFacts>;
      }
    ).outcome;
    expect(textedBefore.textedAboutBusiness).toBe(true);
    expect(textedBefore.optOutLineDeliveredAt).not.toBeNull();
    const facts = {
      ...firstTextFacts(),
      textedAboutBusiness: textedBefore.textedAboutBusiness,
      optOutLineDeliveredAt: textedBefore.optOutLineDeliveredAt,
    };
    const doubles = rowDoubles({ row: outboxRowS108(), facts, bundle: skeletonWithS108() });
    const request = finalizeS108();
    const called = await settle(
      faceOf(doubles).finalizeMessage(structuredClone(request), traceFor(request).trace),
    );
    expect(called.thrown).toBeUndefined();
    const answer = called.answer as unknown as Json;
    expect(validator.check("finalizeMessage", "response", answer)).toEqual([]);
    expect(answer).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
    // No fixed line is added, so the plan's one line goes as it is.
    expect(answer.finalParts).toMatchObject({
      row: "out-s1-08-sam",
      sends: [{ kind: "words", text: PLAN_LINE, options: [] }],
      fixedLines: [],
    });
    expect(doubles.plans).toHaveLength(1);
    expect(doubles.plans[0]).toMatchObject({ outboxRowId: "out-s1-08-sam", expectVersion: 1 });
    expect(doubles.plans[0]?.finalParts).toEqual(answer.finalParts);
    expect(doubles.cancels).toEqual([]);
    expect(doubles.reads).toEqual([
      "readOutboxRow out-s1-08-sam@biz-lees-barbershop",
      "readFixedLineFacts out-s1-08-sam@biz-lees-barbershop",
    ]);
  });

  it("the reader mapping reads a line from the row exactly as one from its question: S1-08's row by Sam's owner role, by the sign-up line for Sam with no role, and refused as S1-02's row is (default 214)", async () => {
    const given = rowReaderFixture("row-reader-s1-02-no-role.json").given;
    const s108 = outboxRowS108();
    const noRole: OutboxRowRead = { ...s108, recipient: { ...s108.recipient, roles: [] } };
    /** S1-08 with its line from Rosie sent to another lane. */
    const sayTo = (to: string): BundleDocument =>
      skeletonWithS108((step) => {
        step.say = (step.say as Json[]).map((message) => ({ ...message, to }));
      });
    const ownerByLine = { result: "reader", reader: "owner", from: "signUpLine", roleId: null };
    const cases: {
      label: string;
      read: OutboxRowRead;
      bundle?: BundleDocument;
      section: number;
      lineTo: string;
      outcome: Json;
    }[] = [
      {
        label: "Sam holds his owner role (the fixture's own recipient): read by the role, never by the line",
        read: s108,
        section: 1,
        lineTo: "owner",
        outcome: { result: "reader", reader: "owner", from: "roles", roleId: "role-sam-barber" },
      },
      {
        label: "Sam with no role yet, a person, on S1-08's section 1 line to the owner: by the sign-up line",
        read: noRole,
        section: 1,
        lineTo: "owner",
        outcome: ownerByLine,
      },
      {
        label: "no person on the row",
        read: { ...noRole, recipient: { ...noRole.recipient, personId: null } },
        section: 1,
        lineTo: "owner",
        outcome: { error: "noReader", why: "noRole" },
      },
      {
        label: "a step outside section 1",
        read: noRole,
        bundle: skeletonWithS108((step) => {
          step.section = 2;
        }),
        section: 2,
        lineTo: "owner",
        outcome: { error: "noReader", why: "noRole" },
      },
      {
        label: "a line to no reader lane",
        read: noRole,
        bundle: sayTo("agent"),
        section: 1,
        lineTo: "agent",
        outcome: { error: "noReader", why: "lineHasNoReader" },
      },
      {
        label: "a cust line: read as the customer, never as the owner",
        read: noRole,
        bundle: sayTo("cust"),
        section: 1,
        lineTo: "cust",
        outcome: { result: "reader", reader: "customer", from: "signUpLine", roleId: null },
      },
      {
        label: "a role that reads as no one: never read by the line, though it goes to the owner",
        read: {
          ...s108,
          recipient: {
            ...s108.recipient,
            roles: [{ roleId: "role-sam-own", role: "own_business", version: 1 }],
          },
        },
        section: 1,
        lineTo: "owner",
        outcome: { error: "noReader", why: "roleReadsAsNoOne" },
      },
    ];
    for (const each of cases) {
      const bundle = each.bundle ?? skeletonWithS108();
      const fromRow = await readingOf(each.read, bundle);
      expect(fromRow.request, each.label).toEqual({
        outboxRowId: "out-s1-08-sam",
        bundleId: each.read.row.bundleId,
        line: { step: "S1-08", index: 0, from: "row" },
        recipient: { personId: each.read.recipient.personId, roles: each.read.recipient.roles },
        flow: "A",
        section: each.section,
        lineTo: each.lineTo,
      });
      expect(fromRow.outcome, each.label).toEqual({ outboxRowId: "out-s1-08-sam", ...each.outcome });
      // The exchange is one of K-05 v1.22's rowReader.exchange (v1.20's rules 0 to 7); v1.5's knows no line from the row.
      const exchange = exchangeOf(given, fromRow.request, fromRow.outcome);
      expect(v122Problems("rowReader.exchange", exchange), each.label).toEqual([]);
      expect(rowReaderProblems(exchange), each.label).not.toEqual([]);
      // Where the row is not read as the owner by the sign-up line, the schema refuses that reading of it.
      if (each.outcome !== ownerByLine) {
        const asOwner = exchangeOf(given, fromRow.request, { outboxRowId: "out-s1-08-sam", ...ownerByLine });
        expect(v122Problems("rowReader.exchange", asOwner), each.label).not.toEqual([]);
      }

      // The same read with its line told as from its question: the same outcome, and the same request but `from`.
      const line = each.read.line;
      if (line === null) throw new Error("S1-08's row carries its line");
      const fromQuestion = await readingOf({ ...each.read, line: { ...line, from: "openQuestion" } }, bundle);
      expect(fromQuestion.outcome, each.label).toEqual(fromRow.outcome);
      expect(fromQuestion.request, each.label).toEqual({
        ...fromRow.request,
        line: { step: "S1-08", index: 0, from: "openQuestion" },
      });
      expect(rowReaderProblems(exchangeOf(given, fromQuestion.request, fromQuestion.outcome))).toEqual([]);
    }
  });

  it("the sign-up reading of S1-08's row to Sam with no role: compose input reads the owner, and nothing is stored or handed on as a role", async () => {
    const s108 = outboxRowS108();
    const read: OutboxRowRead = { ...s108, recipient: { ...s108.recipient, roles: [] } };
    const doubles = rowDoubles({ row: read, bundle: skeletonWithS108() });
    const row = await composeRowOf(doubles.binding, structuredClone(read));
    expect(row).toMatchObject({ step: "S1-08", line: 0, role: "owner", name: "Sam Lee" });
    expect((await finalizeRowOf(doubles.binding, structuredClone(read))).reader).toBe("owner");
    expect(read.recipient.roles).toEqual([]);
    expect(doubles.plans).toEqual([]);
  });

  it("the S1-02 row is unchanged: read-outbox-row-s1-02-older-row.json's answer, its line from its question, gives the compose and finalize rows read-outbox-row-s1-02-no-kinds.json's gives, but the moment", async () => {
    const older = outboxRowOlder();
    const noKinds = outboxRowNoKinds();
    expect(v122Problems("readOutboxRow.v1dot6Response", older)).toEqual([]);
    expect(older.line).toEqual({ step: "S1-02", index: 0, from: "openQuestion" });
    expect(older).toEqual({ ...noKinds, readAt: older.readAt });
    expect(older.readAt).not.toBe(noKinds.readAt);

    const doubles = rowDoubles({ row: older });
    const composed = await composeRowOf(doubles.binding, structuredClone(older));
    const composedBefore = await composeRowOf(rowDoubles({ row: noKinds }).binding, structuredClone(noKinds));
    expect(composed).toEqual({
      ...composedBefore,
      source: { ...composedBefore.source, filledAt: older.readAt },
    });
    expect(composed).toMatchObject({ step: "S1-02", line: 0, role: "owner" });

    const finalized = await finalizeRowOf(doubles.binding, structuredClone(older));
    const finalizedBefore = await finalizeRowOf(
      rowDoubles({ row: noKinds }).binding,
      structuredClone(noKinds),
    );
    expect(finalized).toEqual({
      ...finalizedBefore,
      source: { ...finalizedBefore.source, filledAt: older.readAt },
    });
    expect(finalized.question).toEqual({
      openQuestionId: "oq-s1-02-sam-1",
      openQuestionVersion: 1,
      clockRowId: "clock-oq-s1-02-sam-1",
      clockVersion: 1,
    });
  });

  it("a row that asks a question and holds its own step and line (as the walk will stamp it) gives the rows its question's line gives: S1-02's, its question and clock row kept", async () => {
    const fromQuestion = outboxRowS102();
    const fromRow: OutboxRowRead = { ...fromQuestion, line: { step: "S1-02", index: 0, from: "row" } };
    expect(fromQuestion.line).toEqual({ step: "S1-02", index: 0, from: "openQuestion" });
    expect(v122Problems("readOutboxRow.v1dot6Response", fromRow)).toEqual([]);

    const doubles = rowDoubles({ row: fromRow });
    const before = rowDoubles().binding;
    expect(await composeRowOf(doubles.binding, structuredClone(fromRow))).toEqual(
      await composeRowOf(before, structuredClone(fromQuestion)),
    );
    const finalized = await finalizeRowOf(doubles.binding, structuredClone(fromRow));
    expect(finalized).toEqual(await finalizeRowOf(before, structuredClone(fromQuestion)));
    expect(finalized.question).toMatchObject({
      openQuestionId: "oq-s1-02-sam-1",
      clockRowId: "clock-oq-s1-02-sam-1",
    });

    // Through the face after turn 1: compose-input-s1-02-v1.6.json's input word for word, as from its question.
    const face = await faceAfterTurnOne(doubles);
    const { request, outcome } = composeExchange();
    const answer = await face.composeInput(structuredClone(request), traceFor(request).trace);
    expect(answer).toEqual({ result: "compose", input: outcome.input });
  });

  it("a null line is still refused, never guessed: a row that holds neither column and asks no question (read-outbox-row-no-question.json, frozen), and S1-08's row read with no line", async () => {
    // A v1.3 answer (no switch), handed in as one only for its null line.
    const frozen = k05Read("read-outbox-row-no-question.json");
    expect(frozen.line).toBeNull();
    expect(frozen.slotSource.question).toBeNull();
    const s108NoLine: OutboxRowRead = { ...outboxRowS108(), line: null };
    for (const read of [frozen, s108NoLine]) {
      const { binding } = rowDoubles({ row: read, bundle: skeletonWithS108() });
      const refusals: (() => Promise<unknown>)[] = [
        () => composeRowOf(binding, structuredClone(read)),
        () => finalizeRowOf(binding, structuredClone(read)),
        () => readerOfRow(binding.bundles, structuredClone(read)),
      ];
      for (const refuse of refusals) {
        const refused = await settle(refuse());
        expect(refused.thrown).toBeInstanceOf(TurnFaceRefusedError);
        expect(refused.thrown).toMatchObject({ fault: "noLine" });
      }
    }

    // Through the face on S1-08's row with no line: compose input and finalize both fail closed, nothing written.
    const doubles = rowDoubles({ row: s108NoLine, bundle: skeletonWithS108() });
    const compose = forS108(composeExchange().request);
    const composed = await settle(
      faceOf(doubles).composeInput(structuredClone(compose), traceFor(compose).trace),
    );
    expect(composed.thrown).toMatchObject({ name: "TurnFaceRefusedError", fault: "noLine" });
    const finalize = finalizeS108();
    const finalized = await settle(
      faceOf(doubles).finalizeMessage(structuredClone(finalize), traceFor(finalize).trace),
    );
    expect(finalized.thrown).toMatchObject({ name: "TurnFaceRefusedError", fault: "noLine" });
    expect(doubles.plans).toEqual([]);
    expect(doubles.reads).toEqual([
      "readOutboxRow out-s1-08-sam@biz-lees-barbershop",
      "readOutboxRow out-s1-08-sam@biz-lees-barbershop",
    ]);
  });

  it("a line from the row is never guessed either: a step the row's bundle does not hold is refused (stepMissing), as the skeleton alone holds no S1-08", async () => {
    const read = outboxRowS108();
    const { binding } = rowDoubles({ row: read });
    const refusals: (() => Promise<unknown>)[] = [
      () => composeRowOf(binding, structuredClone(read)),
      () => finalizeRowOf(binding, structuredClone(read)),
    ];
    for (const refuse of refusals) {
      const refused = await settle(refuse());
      expect(refused.thrown).toBeInstanceOf(TurnFaceRefusedError);
      expect(refused.thrown).toMatchObject({ fault: "stepMissing" });
    }
    // An index S1-08 has no line from Rosie at: no role Sam holds reads it, and with no role the line has no reader.
    const second: OutboxRowRead = { ...read, line: { step: "S1-08", index: 1, from: "row" } };
    const byRole = await settle(
      composeRowOf(rowDoubles({ row: second, bundle: skeletonWithS108() }).binding, structuredClone(second)),
    );
    expect(byRole.thrown).toMatchObject({
      name: "TurnFaceRefusedError",
      fault: "noReader",
      why: "roleReadsAsNoOne",
    });
    const noRole: OutboxRowRead = { ...second, recipient: { ...second.recipient, roles: [] } };
    const byLine = await settle(
      composeRowOf(rowDoubles({ row: noRole, bundle: skeletonWithS108() }).binding, structuredClone(noRole)),
    );
    expect(byLine.thrown).toMatchObject({
      name: "TurnFaceRefusedError",
      fault: "noReader",
      why: "lineHasNoReader",
    });
  });

  it("a row whose question holds options is still notBuilt, whichever its line is read from (default 7): S1-02's row with options, its line from the row", async () => {
    const withOptions = (from: "openQuestion" | "row"): OutboxRowRead =>
      rowWith((row) => {
        const question = row.slotSource.question;
        if (question === null) throw new Error("S1-02's row asks its question");
        return {
          ...row,
          line: { step: "S1-02", index: 0, from },
          slotSource: {
            ...row.slotSource,
            question: { ...question, options: [{ id: "o-1", label: "1 Yes" }] },
          },
        };
      });
    for (const from of ["row", "openQuestion"] as const) {
      const read = withOptions(from);
      expect(v122Problems("readOutboxRow.v1dot6Response", read)).toEqual([]);
      const compose = composeExchange().request;
      const composed = await faceOf(rowDoubles({ row: read })).composeInput(
        structuredClone(compose),
        traceFor(compose).trace,
      );
      expect(composed, from).toEqual({ error: "notBuilt", call: "composeInput" });
      const doubles = rowDoubles({ row: read, facts: firstTextFacts() });
      const finalize = finalizeExchange().request;
      const finalized = await faceOf(doubles).finalizeMessage(
        structuredClone(finalize),
        traceFor(finalize).trace,
      );
      expect(finalized, from).toEqual({ error: "notBuilt", call: "finalizeMessage" });
      expect(doubles.plans).toEqual([]);
    }
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

  it("through the face it leaves no span of the base's; without the face's option, the same handlers on the base give the same answer, write the same plan once and record its one fillAndChecks span, never the text (T-1193)", async () => {
    const bundle: BundleDocument = publishedBundleV0();
    const onTheRow = (): RowDoubles =>
      rowDoubles({ row: rowUnderPublishedV0(), facts: firstTextFacts(), bundle });
    const { request } = finalizeExchange();
    const faceDoubles = onTheRow();
    const viaFace = traceFor(request);
    const answer = await faceOf(faceDoubles).finalizeMessage(structuredClone(request), viaFace.trace);
    expect(viaFace.spans).toEqual([]);

    const doubles = onTheRow();
    const { trace, spans } = traceFor(request);
    expect(await baseOf(doubles).call("finalizeMessage", structuredClone(request), trace)).toEqual(answer);
    expect(answer).toMatchObject({ outcome: "send" });
    expect(doubles.plans).toEqual(faceDoubles.plans);
    expect(doubles.plans).toHaveLength(1);

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span).toMatchObject({
      hop: "fillAndChecks",
      trace_id: "trace-sam-0000",
      turn_id: "turn-s1-01-sam",
      outcome: "ok",
      got: { toolCall: "finalizeMessage", callerKind: "turn" },
    });
    expect(validator.checkSpan(span)).toEqual([]);
    // Each line of the text it sends (the opener, the question, the opt-out line, the privacy link): none in the span.
    const sent = (answer as unknown as { finalParts: { sends: { text: string }[] } }).finalParts.sends;
    const lines = (sent[0]?.text ?? "").split("\n").filter((line) => line.length >= 12);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(JSON.stringify(spans)).not.toContain(line);
  });

  it("the opener names the business as limit 7 shows it: the display name, under the switch (businessSensitive true)", async () => {
    const row = rowUnderPublishedV0(
      rowWith((each) => {
        const business = each.slotSource.business;
        if (business === null) throw new Error("the row names its business");
        return {
          ...each,
          slotSource: { ...each.slotSource, business: { ...business, displayName: "Lee's" } },
          businessSensitive: true,
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

describe("the sensitive switch: K-05 v1.6's businessSensitive for a row about no booking (T-1190; item 45; DL-391, DL-395, DL-402)", () => {
  /** The read with the barbershop's display name apart from its name, so the two forms of biz.name tell apart. */
  function displayNameApart(read: OutboxRowRead): OutboxRowRead {
    const business = read.slotSource.business;
    if (business === null) throw new Error("the row names its business");
    return { ...read, slotSource: { ...read.slotSource, business: { ...business, displayName: "Lee's" } } };
  }

  /** The answers the switch comes in, each on S1-02's row: false, null, the field left out and true (DL-395). */
  function switchCases(): { label: string; read: OutboxRowRead; on: boolean }[] {
    return [
      { label: "false (read-outbox-row-s1-02-not-sensitive.json)", read: outboxRowS102(), on: false },
      { label: "null (read-outbox-row-s1-02-no-kinds.json)", read: outboxRowNoKinds(), on: true },
      // A v1.3 to v1.5 answer: no v1.6 answer, handed in as one only to show the field left out reads as on.
      {
        label: "left out (read-outbox-row-s1-02.json)",
        read: outboxRowSwitchLeftOut() as OutboxRowRead,
        on: true,
      },
      { label: "true", read: { ...outboxRowS102(), businessSensitive: true }, on: true },
    ];
  }

  /** What one read gives through the face: compose input after turn 1, finalize's business name and its sent text. */
  async function throughTheFace(read: OutboxRowRead) {
    const { request, outcome } = composeExchange();
    const composed = await (
      await faceAfterTurnOne(rowDoubles({ row: read }))
    ).composeInput(structuredClone(request), traceFor(request).trace);
    expect(validator.check("composeInput", "response", composed)).toEqual([]);
    const finalizeRow = await finalizeRowOf(rowDoubles({ row: read }).binding, structuredClone(read));
    const doubles = rowDoubles({
      row: rowUnderPublishedV0(read),
      facts: firstTextFacts(),
      bundle: publishedBundleV0(),
    });
    const finalize = finalizeExchange().request;
    const finalized = (await faceOf(doubles).finalizeMessage(
      structuredClone(finalize),
      traceFor(finalize).trace,
    )) as unknown as Json & { checks: { checked: { sends: { text: string }[] } }[] };
    expect(validator.check("finalizeMessage", "response", finalized)).toEqual([]);
    expect(finalized.outcome).toBe("send");
    return {
      composed,
      routine: { result: "compose", input: outcome.input },
      gentle: { result: "compose", input: { ...outcome.input, situation: "gentle" } },
      businessName: finalizeRow.checks.businessName,
      sensitive: finalizeRow.source.sensitive,
      text: finalized.checks[0]?.checked.sends[0]?.text ?? "",
    };
  }

  const OPENER = "This is Rosie, the automated booking assistant for";

  it("a business with the switch off (false) gives routine and biz.name: compose-input-s1-02-v1.6.json's input word for word, and the opener names Lee's Barbershop", async () => {
    const read = displayNameApart(outboxRowS102());
    expect(read.businessSensitive).toBe(false);
    const seen = await throughTheFace(read);
    expect(seen.composed).toEqual(seen.routine);
    expect(seen.sensitive).toBe(false);
    expect(seen.businessName).toBe("Lee's Barbershop");
    expect(seen.text.startsWith(`${OPENER} Lee's Barbershop.`)).toBe(true);
  });

  it("one with it on (true) gives gentle and the display name", async () => {
    const read = displayNameApart({ ...outboxRowS102(), businessSensitive: true });
    const seen = await throughTheFace(read);
    expect(seen.composed).toEqual(seen.gentle);
    expect(seen.sensitive).toBe(true);
    expect(seen.businessName).toBe("Lee's");
    expect(seen.text.startsWith(`${OPENER} Lee's.`)).toBe(true);
    expect(seen.text).not.toContain("Lee's Barbershop");
  });

  it("one with no stored setting gives on (fail closed): null (no kinds of work: read-outbox-row-s1-02-no-kinds.json) and the field left out (a v1.3 to v1.5 answer, default 67) each give gentle and the display name", async () => {
    const leftOut = outboxRowSwitchLeftOut();
    expect(Object.hasOwn(leftOut, "businessSensitive")).toBe(false);
    for (const read of [outboxRowNoKinds(), leftOut as OutboxRowRead]) {
      expect(read.businessSensitive ?? null).toBeNull();
      const seen = await throughTheFace(displayNameApart(read));
      expect(seen.composed).toEqual(seen.gentle);
      expect(seen.sensitive).toBe(true);
      expect(seen.businessName).toBe("Lee's");
      expect(seen.text.startsWith(`${OPENER} Lee's.`)).toBe(true);
      expect(seen.text).not.toContain("Lee's Barbershop");
    }
  });

  it("only an answer of exactly false is off: false, null, the field left out and true, through the switch, compose input's row and finalize's row (the security review's N1)", async () => {
    const cases = switchCases();
    expect(cases.map((each) => each.read.businessSensitive)).toEqual([false, null, undefined, true]);
    for (const { label, read, on } of cases) {
      expect(sensitiveOf(read), label).toBe(on);
      const doubles = rowDoubles({ row: read });
      expect((await composeRowOf(doubles.binding, structuredClone(read))).source.sensitive, label).toBe(on);
      expect((await finalizeRowOf(doubles.binding, structuredClone(read))).source.sensitive, label).toBe(on);
    }
  });

  it("a row about a booking stays on whatever the business's switch (item 35's table; open gap 30), and the call still answers notBuilt for it (default 7)", async () => {
    const a703 = (
      contractFile("data-access/fixtures/read-outbox-row-a7-03.json") as {
        outcome: Omit<OutboxRowRead, "businessSensitive">;
      }
    ).outcome;
    expect(a703.row.bookingId).not.toBeNull();
    expect(a703.slotSource.booking).not.toBeNull();
    const s102 = outboxRowS102();
    const booking = a703.slotSource.booking;
    const aboutABooking: OutboxRowRead[] = [
      { ...a703, businessSensitive: false },
      { ...s102, row: { ...s102.row, bookingId: a703.row.bookingId } },
      { ...s102, slotSource: { ...s102.slotSource, booking } },
    ];
    for (const read of aboutABooking) {
      expect(read.businessSensitive).toBe(false);
      expect(sensitiveOf(read)).toBe(true);
    }
    const { request } = composeExchange();
    for (const read of aboutABooking.slice(1)) {
      const answer = await faceOf(rowDoubles({ row: read })).composeInput(
        structuredClone(request),
        traceFor(request).trace,
      );
      expect(answer).toEqual({ error: "notBuilt", call: "composeInput" });
    }
  });

  it("a read error is thrown, never read as off: a read that fails fails compose input and finalize, nothing composed or written; an error answer K-05 never gives is thrown too", async () => {
    // As db/repo's readOutboxRow throws a failed read's own error (T-1197: a revoked SELECT, 42501).
    const failed = Object.assign(new Error("readOutboxRow failed"), { code: "42501" });
    const { request } = composeExchange();
    const composeDoubles = rowDoubles({ readFails: failed });
    const composed = await settle(
      faceOf(composeDoubles).composeInput(structuredClone(request), traceFor(request).trace),
    );
    expect(composed).toEqual({ thrown: failed });
    expect(composeDoubles.reads).toEqual(["readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop"]);

    const finalizeDoubles = rowDoubles({ readFails: failed, facts: firstTextFacts() });
    const finalize = finalizeExchange().request;
    const finalized = await settle(
      faceOf(finalizeDoubles).finalizeMessage(structuredClone(finalize), traceFor(finalize).trace),
    );
    expect(finalized).toEqual({ thrown: failed });
    expect(finalizeDoubles.reads).toEqual(["readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop"]);
    expect(finalizeDoubles.plans).toEqual([]);

    const unknown = await settle(
      faceOf(rowDoubles({ row: { error: "brokenRecord" } })).composeInput(
        structuredClone(request),
        traceFor(request).trace,
      ),
    );
    expect(unknown.thrown).toBeInstanceOf(TurnFaceReadError);
    expect(unknown.thrown).toMatchObject({ read: "readOutboxRow", code: "brokenRecord" });
  });

  it("K-05's transientError fails the call, never read as on, off or null: compose input and finalize answer their own transient, with no row and nothing written (DL-402 note a)", async () => {
    // A transient answer carries no row and no switch; one that also carried a switch would still not be read as one.
    const transient = { error: "transient", sqlstate: "40001" };
    const withSwitch = { ...transient, businessSensitive: false };
    const { request } = composeExchange();
    for (const row of [transient, withSwitch]) {
      const composed = await faceOf(rowDoubles({ row })).composeInput(
        structuredClone(request),
        traceFor(request).trace,
      );
      expect(composed).toEqual(transient);

      const doubles = rowDoubles({ row, facts: firstTextFacts() });
      const finalize = finalizeExchange().request;
      const finalized = await faceOf(doubles).finalizeMessage(
        structuredClone(finalize),
        traceFor(finalize).trace,
      );
      expect(finalized).toEqual(transient);
      expect(doubles.reads).toEqual(["readOutboxRow outbox-s1-02-sam-1@biz-lees-barbershop"]);
      expect(doubles.plans).toEqual([]);
    }
  });

  it("the JOIN row's compose input equals T-1175's recording 4 request (ai/recordings/composer-inputs/join-s1-02.json): compose-input-s1-02-v1.6.json's input except row, turn and inbound", async () => {
    const recording = joinComposeInput();
    const { turnId, turn } = joinHeldTurn();
    const read = joinRow();
    // The run's own ids: its turn the recording's, its row the walk's for that turn (K-09 v1.5 default 131).
    expect(recording.turn).toBe(turnId);
    expect(recording.row).toBe(read.outboxRowId);
    expect(read.businessSensitive).toBe(false);

    const doubles = rowDoubles({ row: read, bundle: publishedBundleV0() });
    // The words the run's gateAndCommit hands the face (its context's one text, JOIN), held as the face holds a turn's.
    doubles.held.hold(turnId, turn);
    const request = joinComposeRequest();
    const answer = await faceOf(doubles).composeInput(structuredClone(request), traceFor(request).trace);
    expect(validator.check("composeInput", "response", answer)).toEqual([]);
    expect(answer).toEqual({ result: "compose", input: recording });
    expect(doubles.reads).toEqual([`readOutboxRow ${recording.row}@biz-lees-barbershop`]);

    // ...which is compose-input-s1-02-v1.6.json's input but for the run's row, turn and inbound text: routine.
    const { outcome } = composeExchange();
    expect({
      ...outcome.input,
      row: recording.row,
      turn: recording.turn,
      inbound: recording.inbound,
    }).toEqual(recording);
    expect(recording.situation).toBe("routine");
  });
});
