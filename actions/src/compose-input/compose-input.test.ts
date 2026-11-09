// The compose-input call (T-309; K-09 v1 composeInput; K-03 v1 composeInput), through the Tool API base over the fake
// row reader and K-01 v1's sample bundles. The card's checks: compose-input-s1-02.json produced exactly from the
// committed S1-02 row; an input holding frontier choices refused (refuse-frontier-in-input.json); the tag order (a row
// about a death is gentle even when it also names money). And the lead's: the opt-out line never comes from a bundle
// message's plainText or stop marker (DL-245), and the input gives no money words but the record's rows (DL-182).

import { describe, expect, it } from "vitest";

import { SECURE_PAGE_WORDS, claimFacts } from "../finalize/claim-check";
import { barberSource, therapistSource } from "../finalize/claim-check/test-support";
import { fakeBundles } from "../frontier/assemble/test-support";
import {
  ComposeInputRefusedError,
  admitInput,
  notBuiltComposeInputPorts,
  optOutLinesOf,
  withoutOptOutLine,
  type ComposeRow,
  type RowState,
} from "./index";
import {
  a614Step,
  alexRow,
  answerOf,
  bundleV0,
  callComposeInput,
  callOffStep,
  checks,
  inputOf,
  k03Fixture,
  keyOf,
  optOutLineOf,
  requestFor,
  s102Exchange,
  s102Row,
  sayOf,
  stepOf,
  stringsIn,
  thrownBy,
  withSteps,
  ZONE,
} from "./test-support";

const BUSINESS = "biz-lees-barbershop";

/** Bundle v0 with the hand-written customer steps, its opt-out line as written. */
function customerBundle() {
  const bundle = bundleV0();
  return withSteps(bundle, a614Step(optOutLineOf(bundle)), callOffStep());
}

/** What a call threw, as the compose-input call's refusal. */
function refusalOf(thrown: unknown): ComposeInputRefusedError {
  if (!(thrown instanceof ComposeInputRefusedError)) throw new Error("not a compose-input refusal");
  return thrown;
}

function thrownFrom(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

describe("compose-input-s1-02.json is produced exactly from the committed S1-02 row", () => {
  it("answers the fixture's outcome word for word, field order and all, through the Tool API base", async () => {
    const exchange = s102Exchange();
    const called = await callComposeInput(exchange.request, { row: s102Row() });
    expect(answerOf(called)).toStrictEqual(exchange.outcome);
    expect(JSON.stringify(answerOf(called))).toBe(JSON.stringify(exchange.outcome));
  });

  it("reads the row once inside the caller's business scope, then the bundle the row was committed under", async () => {
    const called = await callComposeInput(s102Exchange().request);
    expect(called.reads).toStrictEqual([{ outboxRowId: "outbox-s1-02-sam-1", businessId: BUSINESS }]);
    expect(called.scope.events).toStrictEqual([
      { what: "begin" },
      { what: "scope", businessId: BUSINESS },
      { what: "read", table: "outbox_rows", rowId: "outbox-s1-02-sam-1", scope: BUSINESS },
      { what: "commit" },
    ]);
    const key = keyOf(bundleV0());
    expect(called.bundles.reads).toStrictEqual([`${key}/manifest`, `${key}/flow/A`]);
    expect(called.spans.map((span) => [span.hop, span.outcome, span.error_code])).toStrictEqual([
      ["fillAndChecks", "ok", null],
    ]);
  });

  it("is K-03's input-s1-02.json, its master line bundle v0's S1-02 message text word for word", async () => {
    const input = inputOf(await callComposeInput(s102Exchange().request));
    expect(input).toStrictEqual(k03Fixture("input-s1-02.json"));
    const [line] = sayOf(stepOf(bundleV0(), "S1-02"));
    expect(input.masterText).toStrictEqual({ step: "S1-02", text: line?.text });
  });

  it("is a read: the same row asked again gives the same input", async () => {
    const first = answerOf(await callComposeInput(s102Exchange().request));
    const again = answerOf(await callComposeInput(s102Exchange().request));
    expect(again).toStrictEqual(first);
  });
});

describe("DL-245: the opt-out line comes only from the fixed-line inserter, never from the bundle's message", () => {
  it("S1-02's message is stop-marked and its plainText ends with the opt-out line and the card; the input holds neither", async () => {
    const bundle = bundleV0();
    const optOut = optOutLineOf(bundle);
    const [line] = sayOf(stepOf(bundle, "S1-02"));
    expect(line?.elements).toMatchObject({ stop: "first" });
    expect(line?.plainText).toContain(optOut);
    expect(line?.plainText).toContain("$2 a booking");

    const called = await callComposeInput(s102Exchange().request);
    for (const words of stringsIn(answerOf(called))) {
      expect(words).not.toContain("Reply STOP");
      expect(words).not.toContain("opt out");
      expect(words).not.toContain("Msg & data rates");
      // DL-182, STATE note 56: no money words of the card's (Rosie's $2 fee is a v1.1 term fact, never v1's input).
      expect(words).not.toContain("$2");
      expect(words).not.toContain("Setting up with Rosie");
    }
  });

  it("a message stop-marked true gives the same input, with no opt-out line", async () => {
    const bundle = bundleV0();
    const [line] = sayOf(stepOf(bundle, "S1-02"));
    if (line === undefined) throw new Error("S1-02 says nothing");
    line.elements = { ...(line.elements as object), stop: true };
    const called = await callComposeInput(s102Exchange().request, { bundles: fakeBundles(bundle) });
    expect(answerOf(called)).toStrictEqual(s102Exchange().outcome);
  });

  it("a stop-marked customer line whose plainText carries the line and the code gives only its words", async () => {
    const bundle = customerBundle();
    const optOut = optOutLineOf(bundle);
    const row = alexRow("A6-14", barberSource());
    const input = inputOf(
      await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(bundle) }),
    );
    expect(input.masterText).toStrictEqual({
      step: "A6-14",
      text: "You're booked! Give this code at the chair when you arrive.",
    });
    expect(stringsIn(input).some((words) => words.includes(optOut))).toBe(false);
  });

  it("takes the line out of every Rosie-written text the input carries: the master line, her messages, her questions", async () => {
    const bundle = bundleV0();
    const optOut = optOutLineOf(bundle);
    const [line] = sayOf(stepOf(bundle, "S1-02"));
    if (line === undefined || typeof line.text !== "string") throw new Error("S1-02 says nothing");
    const words = line.text;
    line.text = `${words}\n${optOut}`;
    const row: ComposeRow = {
      ...s102Row(),
      conversation: [
        { from: "rosie", text: `${words}\n${optOut}`, sentAt: { utc: "2026-10-19T18:02:00Z", zone: ZONE } },
        { from: "rosie", text: optOut, sentAt: { utc: "2026-10-19T18:02:01Z", zone: ZONE } },
        {
          from: "reader",
          text: "Barbershop, plumbing, electrical",
          sentAt: { utc: "2026-10-19T18:04:00Z", zone: ZONE },
        },
      ],
      openQuestions: [{ id: "oq-s1-02", text: `${words} ${optOut}` }],
    };
    const input = inputOf(
      await callComposeInput(s102Exchange().request, { row, bundles: fakeBundles(bundle) }),
    );
    expect(input.masterText).toStrictEqual({ step: "S1-02", text: words });
    expect(input.conversation).toStrictEqual([
      { from: "rosie", text: words, sentAt: { utc: "2026-10-19T18:02:00Z", zone: ZONE } },
      {
        from: "reader",
        text: "Barbershop, plumbing, electrical",
        sentAt: { utc: "2026-10-19T18:04:00Z", zone: ZONE },
      },
    ]);
    expect(input.openQuestions).toStrictEqual([{ id: "oq-s1-02", text: words }]);
    expect(stringsIn(input).some((each) => each.includes("Reply STOP"))).toBe(false);
  });

  it("reads the line from the bundle's own fixed lines, and takes it out whole with what joined it", () => {
    const line = optOutLineOf(bundleV0());
    expect(optOutLinesOf(bundleV0().manifest)).toStrictEqual([line]);
    expect(withoutOptOutLine(`Hello.\n${line}`, [line])).toBe("Hello.");
    expect(withoutOptOutLine(`${line}\nHello.`, [line])).toBe("Hello.");
    expect(withoutOptOutLine(`Hello. ${line}`, [line])).toBe("Hello.");
    expect(withoutOptOutLine(" Hello.\n", [line])).toBe(" Hello.\n");
  });
});

describe("never the frontier (K-03 v1 refuse-frontier-in-input.json)", () => {
  it("K-03 v1's check refuses refuse-frontier-in-input.json for its frontier alone, and accepts input-s1-02.json", () => {
    const { checker } = checks();
    expect(checker.check(k03Fixture("invalid/refuse-frontier-in-input.json"))).toStrictEqual([
      "(root) must NOT have additional properties (frontier)",
    ]);
    expect(checker.check(k03Fixture("input-s1-02.json"))).toStrictEqual([]);
  });

  it("an input holding frontier choices is refused, thrown with its problem count and never passed on", () => {
    const thrown = refusalOf(
      thrownFrom(() => admitInput(k03Fixture("invalid/refuse-frontier-in-input.json"), checks().checker)),
    );
    expect(thrown.fault).toBe("inputRefused");
    expect(thrown.problems).toBe(1);
    expect(thrown.message).not.toContain("S1-02/kinds");
    expect(admitInput(k03Fixture("input-s1-02.json"), checks().checker)).toStrictEqual(
      k03Fixture("input-s1-02.json"),
    );
  });

  it("a row read that carries the turn's frontier gives the fixture's input, without a choice of it", async () => {
    const frontier = (k03Fixture("invalid/refuse-frontier-in-input.json") as { frontier: unknown }).frontier;
    const row = { ...s102Row(), frontier } as ComposeRow;
    const called = await callComposeInput(s102Exchange().request, { row });
    expect(answerOf(called)).toStrictEqual(s102Exchange().outcome);
    expect(JSON.stringify(answerOf(called))).not.toContain("frontier");
    expect(JSON.stringify(answerOf(called))).not.toContain("Names the kinds of work");
  });

  it("takes each option's id and label alone: a choice's other fields never reach the input", async () => {
    const choice = {
      id: "c-01",
      label: "All on the list",
      kind: "option",
      definition: "A plug-in holds what one kind of work needs.",
      stakes: "low",
      step: "S1-02",
    };
    const row = { ...s102Row(), options: [choice] } as ComposeRow;
    const input = inputOf(await callComposeInput(s102Exchange().request, { row }));
    expect(input.options).toStrictEqual([{ id: "c-01", label: "All on the list" }]);
  });
});

describe("the situation tag: the first that fits wins (arch 07 line 357; C-090)", () => {
  async function situationOf(row: ComposeRow): Promise<unknown> {
    const called = await callComposeInput(requestFor(row.outboxRowId), {
      row,
      bundles: fakeBundles(customerBundle()),
    });
    return inputOf(called).situation;
  }

  it("a row about a death is gentle even when it also names money (the record's money sentence and a refund)", async () => {
    const row = alexRow("A7-x01", barberSource(), {
      factSlots: ["price"],
      situation: { safetyOutcomes: [], about: ["deathReport", "refund"] },
    });
    expect(await situationOf(row)).toBe("gentle");
  });

  it("without the death report, the same row is money or consent", async () => {
    const row = alexRow("A7-x01", barberSource(), {
      factSlots: ["price"],
      situation: { safetyOutcomes: [], about: ["refund"] },
    });
    expect(await situationOf(row)).toBe("moneyOrConsent");
  });

  it("a money slot alone in the master line makes it money or consent; a problem goes before it", async () => {
    expect(await situationOf(alexRow("A7-x01", barberSource()))).toBe("moneyOrConsent");
    const late = alexRow("A7-x01", barberSource(), {
      situation: { safetyOutcomes: [], about: ["businessCannotMakeIt"] },
    });
    expect(await situationOf(late)).toBe("problem");
  });

  it("a safety outcome other than No, or the sensitive switch, is gentle; No alone is not", async () => {
    const unsure = alexRow("A6-14", barberSource(), {
      situation: { safetyOutcomes: ["No", "Unsure"], about: [] },
    });
    expect(await situationOf(unsure)).toBe("gentle");
    const no = alexRow("A6-14", barberSource(), { situation: { safetyOutcomes: ["No"], about: [] } });
    expect(await situationOf(no)).toBe("routine");
    expect(await situationOf(alexRow("A6-14", therapistSource()))).toBe("gentle");
  });
});

describe("the facts: only what limit 7 lets this reader see (T-311's claimFacts over T-310's filler)", () => {
  const SLOTS = [
    "svc.intext",
    "day",
    "visit.time",
    "pro.name",
    "visit.place",
    "visit.code",
    "alex.staff",
  ] as const;

  it("to the customer: the visit and the code, the place on the secure page, no staff-only name", async () => {
    const row = alexRow("A6-14", barberSource(), { factSlots: [...SLOTS] });
    const input = inputOf(
      await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(customerBundle()) }),
    );
    expect(input.facts).toStrictEqual([
      { slot: "svc.intext", value: "Haircut" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
      { slot: "pro.name", value: "Riley" },
      { slot: "visit.place", value: SECURE_PAGE_WORDS },
      { slot: "visit.code", value: "5160" },
    ]);
  });

  it("the master line's own slots come first, each once; links and send-time slots are never facts", async () => {
    const row = alexRow("A7-x01", barberSource(), {
      factSlots: ["day", "link.secure", "today", "pro.name"],
    });
    const input = inputOf(
      await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(customerBundle()) }),
    );
    const facts = input.facts as { slot: string; value: string }[];
    const slots = facts.map((fact) => fact.slot);
    expect(slots.slice(0, 3)).toStrictEqual(["biz.name", "svc.intext", "day"]);
    expect(facts.slice(0, 3).map((fact) => fact.value)).toStrictEqual([
      "Lee's Barbershop",
      "Haircut",
      "Sat Oct 24",
    ]);
    expect(slots).not.toContain("link.secure");
    expect(slots).not.toContain("today");
    expect(slots.filter((slot) => slot === "day")).toHaveLength(1);
    expect(facts.at(-1)).toStrictEqual({ slot: "pro.name", value: "Riley" });
    // DL-182, STATE note 56: the money sentence is the record's row as limit 7 and T-310's filler give it, or nothing.
    expect(facts.filter((fact) => fact.slot === "pay.back")).toStrictEqual(
      claimFacts(["pay.back"], barberSource(), { reader: "customer" }),
    );
  });

  it("to staff under the sensitive switch: initials, the service on the secure page, and the tag gentle", async () => {
    const bundle = withSteps(bundleV0(), {
      ...callOffStep(),
      say: [
        {
          from: "san",
          to: "staff",
          text: "{{alex.staff}} is off the list.",
          plainText: "{{alex.staff}} is off the list.",
        },
      ],
    });
    const row = alexRow("A7-x01", therapistSource(), {
      role: "staff",
      name: "Maya",
      factSlots: ["svc.intext", "visit.code"],
    });
    const input = inputOf(
      await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(bundle) }),
    );
    expect(input.facts).toStrictEqual([
      { slot: "alex.staff", value: "A.M." },
      { slot: "svc.intext", value: SECURE_PAGE_WORDS },
    ]);
    expect(input.audience).toStrictEqual({ role: "staff", name: "Maya", way: "texts", handlingLine: null });
    expect(input.situation).toBe("gentle");
  });

  it("gives no fact code cannot fill: S1-02's row has no business yet", async () => {
    const row: ComposeRow = { ...s102Row(), factSlots: ["biz.name", "biz.phone"] };
    const input = inputOf(await callComposeInput(s102Exchange().request, { row }));
    expect(input.facts).toStrictEqual([]);
  });
});

describe("the links: each kept only when limit 7 shows it to this reader and code can fill it", () => {
  it("the customer may get the secure, pay and chat links; staff only the secure link", async () => {
    const links = ["link.secure", "link.pay", "link.chat", "link.secure"] as ComposeRow["allowedLinks"];
    const customer = alexRow("A6-14", barberSource(), { allowedLinks: links });
    const toCustomer = inputOf(
      await callComposeInput(requestFor(customer.outboxRowId), {
        row: customer,
        bundles: fakeBundles(customerBundle()),
      }),
    );
    expect(toCustomer.allowedLinks).toStrictEqual(["link.secure", "link.pay", "link.chat"]);

    const bundle = withSteps(bundleV0(), {
      ...a614Step(optOutLineOf(bundleV0())),
      say: [{ from: "san", to: "staff", text: "New booking.", plainText: "New booking." }],
    });
    const staff = alexRow("A6-14", barberSource(), { role: "staff", allowedLinks: links });
    const toStaff = inputOf(
      await callComposeInput(requestFor(staff.outboxRowId), { row: staff, bundles: fakeBundles(bundle) }),
    );
    expect(toStaff.allowedLinks).toStrictEqual(["link.secure"]);
  });

  it("drops a link code has no value for", async () => {
    const row: ComposeRow = { ...s102Row(), allowedLinks: ["link.secure"] };
    const input = inputOf(await callComposeInput(s102Exchange().request, { row }));
    expect(input.allowedLinks).toStrictEqual([]);
  });
});

describe("the conversation, the open questions and the inbound text", () => {
  it("keeps the reader's last 6 messages, oldest first", async () => {
    const conversation = Array.from({ length: 8 }, (_, index) => ({
      from: index % 2 === 0 ? ("reader" as const) : ("rosie" as const),
      text: `Message ${String(index + 1)}`,
      sentAt: { utc: `2026-10-19T18:0${String(index)}:00Z`, zone: ZONE },
    }));
    const row: ComposeRow = { ...s102Row(), conversation };
    const input = inputOf(await callComposeInput(s102Exchange().request, { row }));
    expect((input.conversation as { text: string }[]).map((message) => message.text)).toStrictEqual([
      "Message 3",
      "Message 4",
      "Message 5",
      "Message 6",
      "Message 7",
      "Message 8",
    ]);
  });

  it("gives the inbound text only in a reply to its sender", async () => {
    const own = inputOf(await callComposeInput(s102Exchange().request));
    expect(own.inbound).toStrictEqual({
      text: "Hi, I want to put my barbershop on Rosie",
      sentAt: { utc: "2026-10-19T18:05:00Z", zone: ZONE },
    });
    const base = s102Row();
    if (base.inbound === null) throw new Error("S1-02's row replies to Sam");
    const row: ComposeRow = { ...base, inbound: { ...base.inbound, fromHandleId: "handle-alex" } };
    const other = inputOf(await callComposeInput(s102Exchange().request, { row }));
    expect(other.inbound).toBeNull();
  });

  it("passes the options word for word and the open questions as sent, and the step's page types", async () => {
    const row = alexRow("A7-x01", barberSource(), {
      options: [
        { id: "c-01", label: "Yes" },
        { id: "c-02", label: "Call Alex" },
      ],
      openQuestions: [{ id: "oq-alex-1", text: "Shall I book it?" }],
    });
    const input = inputOf(
      await callComposeInput(requestFor(row.outboxRowId), { row, bundles: fakeBundles(customerBundle()) }),
    );
    expect(input.options).toStrictEqual([
      { id: "c-01", label: "Yes" },
      { id: "c-02", label: "Call Alex" },
    ]);
    expect(input.openQuestions).toStrictEqual([{ id: "oq-alex-1", text: "Shall I book it?" }]);
    expect(input.pageTypes).toStrictEqual(["visit"]);
  });
});

describe("what the row is: K-09 v1's errors and the email copy", () => {
  it("passes K-05's notFound and transient on as composeInput's own errors", async () => {
    const notFound = { error: "notFound" as const, table: "outbox_rows", rowId: "outbox-s1-02-sam-1" };
    expect(answerOf(await callComposeInput(s102Exchange().request, { row: notFound }))).toStrictEqual(
      notFound,
    );
    const transient = { error: "transient" as const, sqlstate: "40001" };
    expect(answerOf(await callComposeInput(s102Exchange().request, { row: transient }))).toStrictEqual(
      transient,
    );
  });

  it("answers rowClosed for a row no longer to be sent", async () => {
    const closed: RowState[] = ["dropped_stopped", "withdrawn", "superseded", "failed"];
    for (const state of closed) {
      const called = await callComposeInput(s102Exchange().request, { row: { ...s102Row(), state } });
      expect(answerOf(called)).toStrictEqual({
        error: "rowClosed",
        outboxRowId: "outbox-s1-02-sam-1",
        state,
      });
      expect(called.bundles.reads).toStrictEqual([]);
    }
  });

  it("answers alreadyPlanned for a row that holds a plan, whatever its open state", async () => {
    for (const state of ["planned", "stale", "checked"] as RowState[]) {
      const called = await callComposeInput(s102Exchange().request, {
        row: { ...s102Row(), state, hasPlan: true },
      });
      expect(answerOf(called)).toStrictEqual({ error: "alreadyPlanned", outboxRowId: "outbox-s1-02-sam-1" });
    }
  });

  it("composes a stale row again, from today's record", async () => {
    const called = await callComposeInput(s102Exchange().request, { row: { ...s102Row(), state: "stale" } });
    expect(answerOf(called)).toStrictEqual(s102Exchange().outcome);
  });

  it("answers an email copy with its text row, and no composer input", async () => {
    const row: ComposeRow = { ...s102Row(), channel: "email", copyOfRowId: "outbox-s1-02-sam-text" };
    const called = await callComposeInput(s102Exchange().request, { row });
    expect(answerOf(called)).toStrictEqual({ result: "emailCopy", textRowId: "outbox-s1-02-sam-text" });
    expect(called.bundles.reads).toStrictEqual([]);
  });
});

describe("fail closed: nothing is composed for a row code cannot compose", () => {
  async function refusal(
    row: unknown,
    bundles = fakeBundles(customerBundle()),
  ): Promise<ComposeInputRefusedError> {
    const called = await callComposeInput(s102Exchange().request, { row: row as ComposeRow, bundles });
    expect(called.spans.map((span) => [span.hop, span.outcome])).toStrictEqual([["fillAndChecks", "failed"]]);
    expect(called.scope.events.at(-1)).toStrictEqual({ what: "rollback" });
    return refusalOf(thrownBy(called));
  }

  it("refuses a fixed-line row (STATE note 17), a row read for another row, and a copy on a text channel", async () => {
    expect((await refusal({ ...s102Row(), fixedLineId: "stopReply" })).fault).toBe("fixedLineRow");
    expect((await refusal({ ...s102Row(), outboxRowId: "outbox-other" })).fault).toBe("rowMismatch");
    expect((await refusal({ ...s102Row(), copyOfRowId: "outbox-text" })).fault).toBe("copyNotEmail");
  });

  it("refuses a row with no plan that is past composing (K-07 v1: checked, sending, sent, held)", async () => {
    for (const state of ["checked", "sending", "sent", "delivered", "held", "waiting_chat"] as RowState[]) {
      expect((await refusal({ ...s102Row(), state })).fault).toBe("rowNotComposable");
    }
  });

  it("refuses a recipient no message is written for (own_business reads as no one)", async () => {
    expect((await refusal({ ...s102Row(), role: "own_business" })).fault).toBe("noReader");
  });

  it("refuses when the bundle, the step or the reader's line is missing", async () => {
    expect((await refusal(s102Row(), fakeBundles())).fault).toBe("bundleMissing");
    expect((await refusal({ ...s102Row(), step: "S1-04" })).fault).toBe("stepMissing");
    expect((await refusal({ ...s102Row(), role: "staff" })).fault).toBe("noMasterLine");
    expect((await refusal({ ...s102Row(), line: 1 })).fault).toBe("noMasterLine");
  });

  it("refuses an input K-03 v1 refuses: a language that is not a two-letter code, or no format allowed", async () => {
    expect((await refusal({ ...s102Row(), language: "english" })).fault).toBe("inputRefused");
    expect((await refusal({ ...s102Row(), allowedFormats: [] })).fault).toBe("inputRefused");
  });

  it("answers notBuilt, reading nothing, while the row reader is not built", async () => {
    const called = await callComposeInput(s102Exchange().request, { ports: notBuiltComposeInputPorts() });
    expect(answerOf(called)).toStrictEqual({ error: "notBuilt", call: "composeInput" });
    expect(called.scope.events.filter((event) => event.what === "read")).toStrictEqual([]);
    expect(called.bundles.reads).toStrictEqual([]);
  });

  it("names no value or step words in what it throws", async () => {
    const thrown = await refusal({ ...s102Row(), language: "english" });
    expect(thrown.message).toBe("composeInput: refused (inputRefused); nothing was composed");
  });
});
