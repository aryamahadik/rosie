// Doubles and helpers for the compose-input call's tests (T-309). Never imported by the Worker. No database and no KV:
// the row reader is a fake that answers one row read, reading through the call's scoped repo so the recording scope
// writes down the business scope the read ran under; the bundles are K-01 v1's sample bundles (the frontier's fakes).
// Values come only from the contracts' fixtures and the master's sample cast (Sam, Alex M., Riley, Lee's Barbershop,
// the therapist demo shop; the 555-01xx range): rule 9.

import type { Span } from "../../../runtime/src/trace";
import type { SlotSource } from "../finalize/slots";
import {
  bundleIdOf,
  fakeBundles,
  sampleBundle,
  type BundleDocument,
  type FakeBundles,
} from "../frontier/assemble/test-support";
import { bundleKey } from "../frontier/assemble/types";
import {
  contractFile,
  fixture,
  recordingScope,
  traceFor,
  type RecordingRepo,
  type RecordingScope,
} from "../tool-api/test-support";
import { createToolApi, type CallAnswer } from "../tool-api/tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../tool-api/validator";
import { createComposeInputChecker, type ComposeInputChecker } from "./check";
import { composeInputHandlers } from "./handler";
import type { ComposeInputPorts, ComposeInputRequest, ComposeRow, ComposeRowRead } from "./types";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sam's and Lee's Barbershop's zone (K-04 v1 seed-business-head.json). */
export const ZONE = "America/New_York";

// ---------------------------------------------------------------------------------------------------------------
// K-09 v1's compose-input-s1-02.json and its row

/** compose-input-s1-02.json: its request and its outcome. */
export interface ComposeExchange {
  call: "composeInput";
  request: ComposeInputRequest;
  outcome: Json & { result: "compose"; input: Json };
}

/** K-09 v1's compose-input-s1-02.json, freshly parsed. */
export function s102Exchange(): ComposeExchange {
  return fixture("compose-input-s1-02.json") as ComposeExchange;
}

/** compose-input-s1-02.json's request for another row of the same turn and caller. */
export function requestFor(outboxRowId: string): ComposeInputRequest {
  return { ...s102Exchange().request, outboxRowId };
}

/** Bundle v0 (K-01 v1's bundle-v0-skeleton.json), freshly parsed: the bundle compose-input-s1-02.json's turn pins. */
export function bundleV0(): BundleDocument {
  return sampleBundle("bundle-v0-skeleton.json");
}

/** The bundle key of a sample bundle, as the fake bundles name their reads. */
export function keyOf(document: BundleDocument): string {
  return bundleKey(bundleIdOf(document));
}

/**
 * The row Sam's first text committed (compose-input-s1-02.json's note: "Sam's first text 'Hi, I want to put my
 * barbershop on Rosie' committed turn-s1-01-sam (S1-01 gave thread) with S1-02's question as one outbox row"): S1-02's
 * line to Sam, the owner, on iMessage, under bundle v0, in reply to his own text, which the safety read found No. No
 * business is set up yet, so no fact; S1-02 asks its question in words (no options) and nothing is open with Sam.
 */
export function s102Row(): ComposeRow {
  return {
    outboxRowId: "outbox-s1-02-sam-1",
    turnId: "turn-s1-01-sam",
    state: "planned",
    hasPlan: false,
    channel: "imessage",
    copyOfRowId: null,
    fixedLineId: null,
    recipientHandleId: "handle-sam",
    bundleId: bundleIdOf(bundleV0()),
    flow: "A",
    step: "S1-02",
    line: 0,
    role: "owner",
    name: "Sam",
    way: "texts",
    handlingLine: null,
    language: "en",
    source: {
      filledAt: "2026-10-19T18:05:05Z",
      zones: { visit: null, business: ZONE },
      channel: "imessage",
      sensitive: false,
      record: null,
      facts: {},
    },
    claim: {},
    factSlots: [],
    conversation: [],
    allowedFormats: ["text"],
    allowedLinks: [],
    options: [],
    openQuestions: [],
    inbound: {
      text: "Hi, I want to put my barbershop on Rosie",
      sentAt: { utc: "2026-10-19T18:05:00Z", zone: ZONE },
      fromHandleId: "handle-sam",
    },
    situation: { safetyOutcomes: ["No"], about: [] },
  };
}

/** The opt-out line as bundle v0 writes it (K-01 v1 manifest lists.fixedLines optOutLine; S13-02). */
export function optOutLineOf(document: BundleDocument): string {
  const lists = isRecord(document.manifest.lists) ? document.manifest.lists : {};
  const fixedLines = isRecord(lists.fixedLines) ? lists.fixedLines : {};
  const lines: unknown[] = Array.isArray(fixedLines.lines) ? fixedLines.lines : [];
  const line = lines.find((each) => isRecord(each) && each.id === "optOutLine");
  if (!isRecord(line) || typeof line.text !== "string") throw new Error("bundle v0 holds no opt-out line");
  return line.text;
}

/** A step of flow A of a sample bundle, as written (a test may change its copy). */
export function stepOf(document: BundleDocument, step: string): Json {
  const flow = document.flows.A;
  const steps = isRecord(flow) && isRecord(flow.steps) ? flow.steps : {};
  const found = steps[step];
  if (!isRecord(found)) throw new Error(`flow A holds no step ${step}`);
  return found;
}

/** The messages a step says, as written. */
export function sayOf(step: Json): Json[] {
  return Array.isArray(step.say) ? step.say.filter(isRecord) : [];
}

/** A sample bundle with more steps in flow A, each written by hand in K-01 v1's shape (bundle v0 holds S1-01, S1-02). */
export function withSteps(document: BundleDocument, ...steps: Json[]): BundleDocument {
  const flow = document.flows.A;
  if (!isRecord(flow) || !isRecord(flow.steps)) throw new Error("the bundle has no flow A");
  for (const step of steps) {
    if (typeof step.id !== "string") throw new Error("a step needs its id");
    flow.steps[step.id] = step;
  }
  return document;
}

/** One message line in K-01 v1's shape: from Rosie to a lane, its words, its elements and its plain-text form. */
function message(to: string, text: string, elements: Json, plainText: string): Json {
  return { from: "san", to, text, elements, plainText };
}

/**
 * A6-14's confirmation to the customer, written by hand in K-01 v1's shape: its line as the composer prompt's worked
 * example 2 gives it (T-372: "You're booked! Give this code at the chair when you arrive."), stop-marked, with the code
 * element and the plain-text form msgtext.js writes, which ends with the opt-out line (msgtext.js lines 60, 65).
 */
export function a614Step(optOutLine: string): Json {
  const text = "You're booked! Give this code at the chair when you arrive.";
  return {
    id: "A6-14",
    section: 6,
    lines: ["6.14"],
    who: "san",
    via: "msg",
    title: "Confirms the booking",
    does: "The customer gets the booking and the check-in code.",
    say: [
      message("cust", text, { code: "5160", stop: true }, `${text}\nYour check-in code: 5160\n${optOutLine}`),
    ],
    pageTypes: [],
    next: "A6-15",
    lint: [],
  };
}

/**
 * A test step, written by hand in K-01 v1's shape under a trade's own step id (SPEC-prof 3: A7-x01), so it names no
 * master step: the business calls a visit off and says what goes back. Its line names the business, the service, the
 * day and the record's money sentence as slots (pay.back: "what goes back ... when the business calls it off").
 */
export function callOffStep(): Json {
  const text =
    "{{biz.name:Lee's Barbershop}} has called off your {{svc.intext:Haircut}} on {{day:Sat Oct 24}}. {{pay.back}}";
  return {
    id: "A7-x01",
    section: 7,
    lines: ["7.1"],
    who: "san",
    via: "msg",
    title: "A test step: the business calls the visit off",
    does: "The customer is told the visit is off and what goes back.",
    say: [message("cust", text, {}, text)],
    pageTypes: ["visit"],
    next: null,
    lint: [],
  };
}

/** Alex M.'s row at Lee's Barbershop (the barber source: claim-check's test support), for a customer step. */
export function alexRow(step: string, source: SlotSource, overrides: Partial<ComposeRow> = {}): ComposeRow {
  return {
    ...s102Row(),
    outboxRowId: "outbox-alex-1",
    turnId: "turn-alex-1",
    recipientHandleId: "handle-alex",
    step,
    role: "customer",
    name: "Alex",
    source,
    factSlots: [],
    inbound: null,
    situation: { safetyOutcomes: [], about: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The row reader fake

/** What the fake row reader saw: each row asked for and the business scope of the call it ran in. */
export interface FakePorts extends ComposeInputPorts<RecordingRepo> {
  readonly reads: { outboxRowId: string; businessId: string }[];
}

/** A row reader answering each read with `answer` (a copy), after reading the row through the call's scoped repo. */
export function fakePorts(answer: ComposeRowRead): FakePorts {
  const reads: { outboxRowId: string; businessId: string }[] = [];
  return {
    reads,
    async readRow(outboxRowId, call) {
      reads.push({ outboxRowId, businessId: call.businessId });
      await call.repo.read("outbox_rows", outboxRowId);
      return structuredClone(answer);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// One call through the Tool API base

let validator: ToolApiValidator | undefined;
let checker: ComposeInputChecker | undefined;

/** The Tool API's validator and the compose-input check, made once for the tests. */
export function checks(): { validator: ToolApiValidator; checker: ComposeInputChecker } {
  validator ??= createToolApiValidator();
  checker ??= createComposeInputChecker();
  return { validator, checker };
}

export interface CallOptions {
  /** The row read (default: S1-02's row). */
  row?: ComposeRowRead;
  /** The ports instead of the fake reader (notBuiltComposeInputPorts, say). */
  ports?: ComposeInputPorts<RecordingRepo>;
  /** The bundles (default: bundle v0). */
  bundles?: FakeBundles;
}

/** What one call left: its answer (or what it threw), the scope's events, the reads, the bundle reads and the span. */
export interface Called {
  answer: { ok: true; value: CallAnswer } | { ok: false; error: unknown };
  scope: RecordingScope;
  reads: FakePorts["reads"];
  bundles: FakeBundles;
  spans: Span[];
}

/** One composeInput call through the Tool API base, over the fake row reader and bundle v0 by default. */
export async function callComposeInput(request: unknown, options: CallOptions = {}): Promise<Called> {
  const fake = fakePorts(options.row ?? s102Row());
  const scope = recordingScope();
  const bundles = options.bundles ?? fakeBundles(bundleV0());
  const handlers = composeInputHandlers<RecordingRepo>({
    ports: options.ports ?? fake,
    bundles,
    checker: checks().checker,
  });
  const api = createToolApi({ validator: checks().validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("composeInput", structuredClone(request), trace).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { answer, scope, reads: fake.reads, bundles, spans };
}

/** The answer of a call that answered; throws when it threw, so a test reads the value plainly. */
export function answerOf(called: Called): CallAnswer {
  if (!called.answer.ok) throw new Error("the call threw instead of answering");
  return called.answer.value;
}

/** The error a call threw; throws when it answered. */
export function thrownBy(called: Called): unknown {
  if (called.answer.ok) throw new Error("the call answered instead of throwing");
  return called.answer.error;
}

/** The composer input of a call that answered compose; throws on any other answer. */
export function inputOf(called: Called): Json {
  const value: unknown = answerOf(called);
  if (!isRecord(value) || value.result !== "compose" || !isRecord(value.input)) {
    throw new Error("the call did not answer a composer input");
  }
  return value.input;
}

/** Reads another contract's file (relative to contracts/), such as a K-03 fixture. */
export function k03Fixture(file: string): unknown {
  return contractFile(`message-plan/fixtures/${file}`);
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}
