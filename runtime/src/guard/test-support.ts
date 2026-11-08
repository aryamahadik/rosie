// Doubles and checks for the guard's tests (T-250). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - the pinned bundle: K-01's bundle v0 (bundle-v0-skeleton.json), its manifest checked against its id by the pin's own
//     check (`manifestOf`, T-249), so the guard reads the keyword list the pin hands a turn;
//   - K-05 v1.2 `handleTargets`: a fake port that answers each handle with an answer the test gives it, such as a K-05
//     fixture's outcome (targets-alex.json, targets-sam-owner.json, targets-first-text.json), and logs every call;
//   - the frozen schemas, through Ajv 2020 (strict, as the contract checks run), so a test can hold a fake's answer to K-05
//     v1.2 and the guard's targets to K-09 v1.
// Test values only: the master's sample cast and K-05's fixture rows (rule 9).

import Ajv2020 from "ajv/dist/2020.js";

import { manifestOf, type Manifest } from "../bundle";
import { BUNDLE_A, WHOLE_A } from "../bundle/test-support";
import { openTrace, type Span, type TraceContext } from "../trace";
import { readContractJson } from "../trace/test-support";
import type { GuardText, HandleTargetsAnswer, HandleTargetsPort, HandleTargetsResponse } from "./types";

// ---- the frozen schemas ---------------------------------------------------------------------------------------------

const ID_BASE = "https://rosie.invalid/contracts/";

/** K-05 v1.2, K-09 v1, K-08 v1.1 and every schema file their references reach. */
const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "inbound-event/inbound-event.v1.schema.json",
  "outbox-effects/outbox-effects.v1.schema.json",
  "event-trace/event-trace.v1.schema.json",
  "event-trace/event-trace.v1.1.schema.json",
  "data-access/data-access.v1.schema.json",
  "data-access/data-access.v1.1.schema.json",
  "data-access/data-access.v1.2.schema.json",
  "tool-api/tool-api.v1.schema.json",
] as const;

export const K05_V1_2 = "data-access/data-access.v1.2.schema.json";
export const K09_V1 = "tool-api/tool-api.v1.schema.json";

let ajv: Ajv2020 | undefined;

function loadedAjv(): Ajv2020 {
  if (ajv === undefined) {
    const created = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const file of SCHEMA_FILES) created.addSchema(readContractJson(file) as object);
    ajv = created;
  }
  return ajv;
}

/** The schema's problems with `value` against `$defs/<definition>` of a frozen schema file; empty when accepted. */
export function contractProblems(file: string, definition: string, value: unknown): string[] {
  const validate = loadedAjv().getSchema(`${ID_BASE}${file}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`${file} has no definition ${definition}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? ""}`,
  );
}

// ---- K-05 v1.2 handleTargets ------------------------------------------------------------------------------------------

/** A K-05 `handleTargets` exchange from contracts/data-access/fixtures. */
export interface TargetsExchange {
  call: "handleTargets";
  request: { handleId: string };
  outcome: HandleTargetsAnswer;
}

export function targetsExchange(name: string): TargetsExchange {
  const exchange = readContractJson(`data-access/fixtures/${name}.json`) as Record<string, unknown>;
  if (exchange.call !== "handleTargets") throw new Error(`${name} is not a handleTargets exchange`);
  return exchange as unknown as TargetsExchange;
}

/** A copy of a K-05 `handleTargets` response (a test changes its copy, never the fixture). */
export function responseOf(exchange: TargetsExchange): HandleTargetsResponse {
  const outcome = structuredClone(exchange.outcome);
  if (!("result" in outcome)) throw new Error("the exchange's outcome is an error");
  return outcome;
}

export interface FakeTargets {
  readonly port: HandleTargetsPort;
  /** What each handle id is answered (left out: K-05's notFound for the handle). */
  readonly answers: Map<string, unknown>;
  /** Throw instead of answering: the call fails with no answer. */
  failing: boolean;
  /** Every request, in order. */
  readonly calls: { handleId: string }[];
}

/** K-05 v1.2 `handleTargets` as a fake: each handle's answer as set in `answers`. */
export function fakeTargets(): FakeTargets {
  const fake: FakeTargets = {
    answers: new Map(),
    failing: false,
    calls: [],
    port: {
      handleTargets(request) {
        fake.calls.push({ handleId: request.handleId });
        if (fake.failing) return Promise.reject(new Error("no answer"));
        const answer = fake.answers.get(request.handleId) ?? {
          error: "notFound",
          table: "handles",
          rowId: request.handleId,
        };
        return Promise.resolve(answer as HandleTargetsAnswer);
      },
    },
  };
  return fake;
}

// ---- the pinned bundle and the turn's trace ---------------------------------------------------------------------------

/** Bundle v0's manifest as the pin checks it (K-01 `bundle-v0-skeleton.json`, the bundle K-05's fixtures name). */
export async function pinnedManifest(): Promise<Manifest> {
  const manifest = await manifestOf(JSON.stringify(WHOLE_A.manifest), BUNDLE_A);
  if (manifest === null) throw new Error("bundle v0's manifest is not its id's");
  return manifest;
}

/** A turn's trace under bundle v0's id, keeping every span it records. */
export function turnTrace(): { trace: TraceContext; spans: Span[] } {
  const spans: Span[] = [];
  let clock = Date.parse("2026-10-23T14:06:12Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE_A,
    sink: (span) => spans.push(span),
    now: () => (clock += 5),
  });
  trace.setTurn("turn-guard-test-1");
  return { trace, spans };
}

// ---- the turn's texts -------------------------------------------------------------------------------------------------

let nextEvent = 0;

/** A typed text (K-06 kind text) with these words; each gets its own event id. */
export function typed(body: string, kind = "text"): GuardText {
  nextEvent += 1;
  return { eventId: `evt-guard-${String(nextEvent).padStart(4, "0")}`, kind, words: { body, subject: null } };
}
