// Doubles and rows for the finalize call's tests (T-313). Never imported by the Worker. The ports are a fake repo that
// keeps one outbox row and writes down every call made to it; the fixed lines come from a double of T-314's inserter.
// Names and values come only from K-09 v1's fixtures, the master's sample cast and fixture set v1's demo shops (Sam,
// Lee's Barbershop, Alex M., Riley; S1-02 and A7-17; October 2026), never a real person (rule 9).

import { claimFacts } from "../claim-check";
import type { CheckLists, FixedLine } from "../checks";
import type { SlotName, SlotSource } from "../slots";
import {
  contractFile,
  fixture,
  recordingScope,
  traceFor,
  type RecordingRepo,
} from "../../tool-api/test-support";
import {
  createToolApi,
  createToolApiValidator,
  notBuiltHandlers,
  type CallAnswer,
  type CallContext,
  type Handlers,
  type ToolApiValidator,
} from "../../tool-api";
import { finalizeMessage, notBuiltPorts } from "../index";
import type {
  CancelClockRequest,
  FinalParts,
  FinalizeNote,
  FinalizePorts,
  FinalizeRequest,
  FinalizeResponse,
  FinalizeRow,
  PassedOnReview,
  WritePlanRequest,
} from "./types";

/** Both shops' zone (K-04 seed-business-head.json). */
export const ZONE = "America/New_York";

/** One K-09 v1 finalizeMessage exchange (finalize-pass.json, finalize-rewrite.json, finalize-passed-on.json). */
export interface FinalizeExchange {
  readonly given: { readonly now: string; readonly note: string };
  readonly request: FinalizeRequest;
  readonly outcome: FinalizeResponse;
}

export function exchange(file: string): FinalizeExchange {
  return fixture(file) as FinalizeExchange;
}

/** K-01 v1's sample shared lists: msgtext.js's 16 opt-out words and the fixed lines (K-01 keywords.json, fixed-lines.json). */
export function bundleLists(): CheckLists {
  return {
    keywords: contractFile("bundle/fixtures/keywords.json") as CheckLists["keywords"],
    fixedLines: contractFile("bundle/fixtures/fixed-lines.json") as CheckLists["fixedLines"],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// S1-02: Sam's first reply (finalize-pass.json)

/**
 * S1-02's opener before there is a business (arch 07 line 361: "S1-02's opener before there is a business"), in the words
 * finalize-pass.json's final parts hold; K-01's sample opener names <business>, which S1-02 has none of yet.
 */
export const S1_02_OPENER = "Hi! I'm Rosie, an automated assistant.";

/**
 * S1-02's card terms: Rosie's own fixed terms, each a line of S1-02's card that names no slot, word for word (K-03 v1.1
 * input-s1-02-v1.1.json's four term facts; CQ-82's ruling, DL-145; CQ-86's default). plan-s1-02.json's fact line states
 * three of them ("Rosie's own $2 fee term kept as words", arch 12 line 592).
 */
export const S1_02_TERMS: readonly string[] = (
  contractFile("message-plan/fixtures/input-s1-02-v1.1.json") as { facts: { value: string }[] }
).facts.map((fact) => fact.value);

/** The row behind finalize-pass.json: S1-02's reply to Sam, the owner, before there is a business. */
export function s102Row(): FinalizeRow {
  const input = contractFile("message-plan/fixtures/input-s1-02.json") as { masterText: { text: string } };
  const lists = bundleLists();
  const opener: FixedLine = { id: "opener", text: S1_02_OPENER, lang: "en" };
  return {
    outboxRowId: "outbox-s1-02-sam-1",
    version: 1,
    state: "planned",
    channel: "imessage",
    finalParts: null,
    fixedLineId: null,
    step: "S1-02",
    reader: "owner",
    claim: {},
    source: {
      filledAt: "2026-10-19T18:05:07Z",
      zones: { visit: null, business: ZONE },
      channel: "imessage",
      sensitive: false,
      record: null,
      facts: {},
    },
    checks: {
      lists: {
        keywords: lists.keywords,
        fixedLines: { lines: [opener, ...lists.fixedLines.lines.filter((line) => line.id !== "opener")] },
      },
      language: "en",
      businessName: null,
      options: [],
      typedOptions: null,
      allowedFormats: ["text"],
      // The composer's facts are S1-02's term facts (K-03 v1.1), which the Values check reads. A term fact has no slot,
      // while the checks' facts (T-312, K-03 v1 `fact`) each name one, so the row read labels each "term" until the
      // message checks take term facts in their own task (K-03 README section "v1.1", consumers).
      facts: S1_02_TERMS.map((value) => ({ slot: "term", value })),
      // The same lines as the row's terms: code-supplied words, outside the Shape and Length counts (DL-158).
      terms: S1_02_TERMS,
      readerName: "Sam",
      masterText: input.masterText.text,
    },
    calendarFile: "none",
    fallbackText: input.masterText.text,
    question: {
      openQuestionId: "oq-s1-02-sam",
      openQuestionVersion: 1,
      clockRowId: "clock-oq-s1-02-sam",
      clockVersion: 1,
    },
  };
}

/** The double of T-314's inserter for Sam's first reply: S1-02's opener before the first line (finalize-pass.json). */
export function openerFirst(parts: FinalParts): FinalParts {
  const [words, ...rest] = parts.sends;
  if (words.kind !== "words" || words.text === null) return parts;
  return {
    ...parts,
    sends: [{ ...words, text: `${S1_02_OPENER} ${words.text}` }, ...rest] as FinalParts["sends"],
    fixedLines: [...parts.fixedLines, "opener"],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A7-17: Riley can't be in, told to Alex (finalize-rewrite.json, finalize-passed-on.json)

/**
 * The open question's deadline in finalize-passed-on.json: 7pm on Fri Oct 23, 2026 in the shop's zone. The fixture's
 * "7pm" is test data (CQ-90 (c): a question's clock arms only at delivery, T-255); T-310's filler words this deadline as
 * K-03 slots.json's ask.by example does ("9:00am Sat"): "7:00pm Fri".
 */
export const ASK_BY = { utc: "2026-10-23T23:00:00Z", zone: ZONE } as const;

/** Lee's Barbershop's facts for Alex M.'s haircut with Riley on Sat Oct 24, 2026 at 11:00am, filled on Fri Oct 23. */
export function a717Source(): SlotSource {
  return {
    filledAt: "2026-10-23T13:00:04Z",
    zones: { visit: ZONE, business: ZONE },
    channel: "imessage",
    sensitive: false,
    record: null,
    facts: {
      business: { name: "Lee's Barbershop", displayName: "Lee's", phone: "+15555550177", ownerName: "Sam" },
      customerName: "Alex M.",
      proName: "Riley",
      serviceName: "Haircut",
      visit: { start: { utc: "2026-10-24T15:00:00Z", zone: ZONE } },
      links: { secure: "rosfield.com/v/s03" },
      askBy: ASK_BY,
    },
  };
}

/** The slots A7-17's composer input names; the composer gets only what limit 7 lets Alex see (K-03 composeInput facts). */
const A7_17_FACT_SLOTS: readonly SlotName[] = ["biz.name", "pro.name", "day", "visit.time", "name.staff"];

/**
 * A7-17's step fallback text, slotted, in the words of K-03 check-passed-on.json's checked text: Riley can't be in, who
 * can come in early instead, and the reply-by deadline. name.staff is owner and staff only (K-03 slots.json), so for
 * Alex limit 7 holds it back, and the text keeps "{{name.staff}}" (DL-158 ruling b).
 */
export const A7_17_FALLBACK =
  "Sorry, {{pro.name}} can't be in on {{day}}. {{name.staff}} can come in early to do your visit, same time and price. Please reply by {{ask.by}}.";

/** The row behind finalize-rewrite.json and finalize-passed-on.json: A7-17's text to Alex, the customer. */
export function a717Row(source: SlotSource = a717Source()): FinalizeRow {
  return {
    outboxRowId: "outbox-a7-17-alex-text",
    version: 1,
    state: "planned",
    channel: "imessage",
    finalParts: null,
    fixedLineId: null,
    step: "A7-17",
    reader: "customer",
    claim: {},
    source,
    checks: {
      lists: bundleLists(),
      language: "en",
      businessName: "Lee's Barbershop",
      options: [],
      typedOptions: null,
      allowedFormats: ["text", "poll", "linkCard", "calendarFile", "tapback"],
      facts: claimFacts(A7_17_FACT_SLOTS, source, { reader: "customer" }),
      terms: [],
      readerName: "Alex",
      masterText: null,
    },
    calendarFile: "none",
    fallbackText: A7_17_FALLBACK,
    question: {
      openQuestionId: "oq-a7-17-alex",
      openQuestionVersion: 1,
      clockRowId: "clock-oq-a7-17-alex",
      clockVersion: 1,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The fake repo

/** What the fake repo was asked, in order. */
export interface FakeCalls {
  readonly reads: string[];
  readonly inserted: FinalParts[];
  readonly writes: WritePlanRequest[];
  readonly cancels: CancelClockRequest[];
  readonly reviews: PassedOnReview[];
}

export interface FakeRepo {
  readonly ports: FinalizePorts<RecordingRepo>;
  readonly calls: FakeCalls;
  /** The row as it stands now (its final parts once written), or null when there is none. */
  row(): FinalizeRow | null;
}

/**
 * A fake repo holding one row. writePlan writes the plan's final parts once, as K-05 v1 item 2 does (alreadyPlanned
 * first, then the version); cancelClock cancels the question's clock and withdraws it; openReviewItem opens one item due
 * a day later. `fixedLines` is T-314's inserter's double (default: the row carries no fixed line).
 */
export function fakeRepo(
  start: FinalizeRow | null,
  fixedLines: (parts: FinalParts, row: FinalizeRow) => FinalParts = (parts) => parts,
): FakeRepo {
  let row = start === null ? null : structuredClone(start);
  const calls: FakeCalls = { reads: [], inserted: [], writes: [], cancels: [], reviews: [] };
  const ports: FinalizePorts<RecordingRepo> = {
    readRow(outboxRowId) {
      calls.reads.push(outboxRowId);
      if (row?.outboxRowId !== outboxRowId)
        return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: outboxRowId });
      return Promise.resolve(structuredClone(row));
    },
    insertFixedLines(parts, current) {
      const added = fixedLines(parts, current);
      calls.inserted.push(structuredClone(added));
      return Promise.resolve(added);
    },
    writePlan(request) {
      calls.writes.push(structuredClone(request));
      if (row === null)
        return Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId });
      if (row.finalParts !== null)
        return Promise.resolve({
          error: "alreadyPlanned",
          outboxRowId: row.outboxRowId,
          version: row.version,
        });
      if (row.version !== request.expectVersion) {
        return Promise.resolve({
          error: "versionChanged",
          changed: [
            {
              table: "outbox_rows",
              rowId: row.outboxRowId,
              readVersion: request.expectVersion,
              currentVersion: row.version,
            },
          ],
        });
      }
      row = {
        ...row,
        finalParts: structuredClone(request.finalParts),
        state: "checked",
        version: row.version + 1,
      };
      return Promise.resolve({ result: "written", outboxRowId: row.outboxRowId, version: row.version });
    },
    cancelClock(request) {
      calls.cancels.push(structuredClone(request));
      if (row !== null) row = { ...row, question: null };
      return Promise.resolve({
        result: "cancelled",
        clockRowId: request.clockRowId,
        version: request.expectVersion + 1,
        cancelledAt: request.at,
        repeated: false,
      });
    },
    openReviewItem(request) {
      calls.reviews.push(structuredClone(request));
      return Promise.resolve({
        reviewItemId: `review-${request.subject?.rowId ?? "none"}`,
        dueAt: "2026-10-26T13:00:09Z",
        repeated: false,
      });
    },
  };
  return { ports, calls, row: () => (row === null ? null : structuredClone(row)) };
}

// ---------------------------------------------------------------------------------------------------------------
// The call, through the Tool API base

let validator: ToolApiValidator | undefined;

/** One strict validator of K-09 v1 for every test (its first compile is slow). */
export function sharedValidator(): ToolApiValidator {
  validator ??= createToolApiValidator();
  return validator;
}

export interface CallRun {
  readonly answer: CallAnswer;
  readonly notes: FinalizeNote[];
  /** The rows the call's span kept (K-08 v1 rowRef), when it kept any. */
  readonly rows: { table: string; id: string }[];
  /** How the call's transaction ended: commit or rollback. */
  readonly ended: string | undefined;
}

/** The time the passed-on question is withdrawn at: finalize-passed-on.json's given now. */
export const NOW = "2026-10-23T13:00:09Z";

/**
 * Runs finalizeMessage through the Tool API base (T-290), which holds the request and the answer to K-09 v1's schema and
 * runs the handler in one transaction scoped to the caller's business: an answer that is not the contract's throws.
 */
export async function runFinalize(
  request: FinalizeRequest,
  ports: FinalizePorts<RecordingRepo> = notBuiltPorts(),
): Promise<CallRun> {
  const notes: FinalizeNote[] = [];
  const scope = recordingScope();
  const handlers: Handlers<RecordingRepo> = {
    ...notBuiltHandlers(),
    finalizeMessage: finalizeMessage<RecordingRepo>({
      ports,
      now: () => NOW,
      log: (note) => notes.push(note),
    }),
  };
  const api = createToolApi({ validator: sharedValidator(), scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("finalizeMessage", request, trace);
  const rows = spans.flatMap((span) => span.rows ?? []);
  const ended = [...scope.events]
    .reverse()
    .find((event) => event.what === "commit" || event.what === "rollback")?.what;
  return { answer, notes, rows, ended };
}

/** A handler's call context outside the base, for the parts of the call tested alone. */
export function bareContext(): CallContext<RecordingRepo> {
  return {
    repo: { read: () => Promise.resolve(null) },
    businessId: "biz-lees-barbershop",
    span: { limits: [], rows: [] },
  };
}

/** Every string anywhere in a value, keys excluded. */
export { stringsIn } from "../../tool-api/test-support";
