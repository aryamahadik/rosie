// The one transport of the AI layer's run over every model-contract fixture (T-376). Every stage of the run (the safety
// read, decide's two reads, the re-read and the composer) sends its Messages API requests here, and nowhere else: the
// suite stubs the global fetch to fail. Each request is answered with
//
//   - an answer the recorded-model double gave (T-004), asked through the double's call log below and keyed by the
//     double's own request key (requestKey), so the log shows which recording answered which request; or
//   - for a fixture K-02 or K-03 refuses, that fixture's own answer, which the double's loader refuses to hold (the run
//     shows that refusal too), so the AI layer meets it as a model might give it; or
//   - no answer at all, for a try that times out (K-02's two timeout fixtures: no verdict in 4 s).
//
// A request the run holds no answer for is a miss: logged, and failed with a 500, so the run fails loudly and never on a
// made-up answer. The wire form is T-364's fake Messages API with Anthropic's prompt cache, so the usage each call
// reports (tokens, cached tokens, cache writes) is what the real API would report for the requests the AI layer sends.
// Never imported by the Worker. No network, no key (J-02; DL-027: CI makes no live call).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fakeCachingApi, type FakeUsage } from "../cache/test-support";
import { composeInputText, type ComposeInput } from "../composer";
import { choiceIdsOf, stepOf, userOf, type StepAnswers } from "../decide/test-support";
import type { FetchLike } from "../gateway";
import {
  canonicalJson,
  requestKey,
  type DecideRole,
  type JsonObject,
  type RecordedComposer,
  type RecordedModel,
} from "../recorded-double";
import { textOfTurn } from "../safety/test-support";
import type { TurnRoute } from "../routing";

/** The repository root: this file is ai/src/fixtures-run/double-transport.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

export type Raw = Record<string, unknown>;

const isRaw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- The recordings the double holds, as their files write them -----------------------------------------------------

/** The kinds of answer the double replays: K-02's three model-facing outputs and the composer's plan (K-03). */
export type DoubleKind = "safetyRead" | "decideRead" | "plannerOutput" | "composerPlan";

/** One recording as its file writes it (ai/recordings; T-004, T-1071, T-1145). */
export interface RecordingSpec {
  readonly id: string;
  readonly kind: DoubleKind;
  readonly request: Raw;
  readonly seed?: { readonly fixture: string };
  readonly output?: unknown;
}

/** One recordings file: its K-02 or K-03 version and its recordings. */
export interface RecordingsFile {
  readonly version: string;
  readonly contract: string;
  readonly recordings: readonly RecordingSpec[];
}

/** The double's four files, as written (the double loads K-02's two as one lookup, and the composer's beside it). */
export const RECORDING_FILES = {
  "recordings.v1.json": readJson("ai/recordings/recordings.v1.json") as RecordingsFile,
  "recordings.v1.1.json": readJson("ai/recordings/recordings.v1.1.json") as RecordingsFile,
  "composer.v1.json": readJson("ai/recordings/composer.v1.json") as RecordingsFile,
} as const;

/** Every recording the double holds, in its files' order. */
export const RECORDINGS: readonly RecordingSpec[] = Object.values(RECORDING_FILES).flatMap(
  (file) => file.recordings,
);

/** A K-02 fixture, by its file in contracts/model/fixtures (fixtures/invalid included). */
export const modelFixture = (file: string): unknown => readJson(`contracts/model/fixtures/${file}`);
/** A K-03 fixture, by its file in contracts/message-plan/fixtures (fixtures/invalid included). */
export const planFixture = (file: string): unknown => readJson(`contracts/message-plan/fixtures/${file}`);

/** A request's context or input as the double's loader resolves it: a fixture, a file of ai/recordings, or inline. */
function resolved(value: unknown, fixtureOf: (file: string) => unknown): unknown {
  if (isRaw(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.fixture === "string") return fixtureOf(value.fixture);
    if (keys.length === 1 && typeof value.file === "string") return readJson(`ai/recordings/${value.file}`);
  }
  return value;
}

/** A recording's request as the double keys it: the text, the context with its role, or the composer's input. */
export function requestOf(recording: RecordingSpec): unknown {
  const { request } = recording;
  switch (recording.kind) {
    case "safetyRead":
      return { text: request.text };
    case "decideRead":
      return { context: resolved(request.context, modelFixture), role: request.role };
    case "plannerOutput":
      return { context: resolved(request.context, modelFixture) };
    case "composerPlan":
      return resolved(request, planFixture);
  }
}

/** The double's own key of each recording's request (requestKey), with the recording's id. */
export function keysOf(recordings: readonly RecordingSpec[]): ReadonlyMap<string, string> {
  return new Map(
    recordings.map((recording) => [requestKey(recording.kind, requestOf(recording)), recording.id]),
  );
}

/** The recordings of one kind seeded from one fixture. */
export const seededFrom = (kind: DoubleKind, fixture: string): RecordingSpec[] =>
  RECORDINGS.filter((recording) => recording.kind === kind && recording.seed?.fixture === fixture);

// ---- The double's call log --------------------------------------------------------------------------------------------

/** One call to the recorded-model double: what kind of answer, and the double's own key of the request. */
export interface DoubleCall {
  readonly kind: DoubleKind;
  readonly key: string;
}

/** Where one answer came from. */
export type Source =
  | { readonly from: "double"; readonly call: DoubleCall }
  | { readonly from: "refusedFixture"; readonly fixture: string }
  | { readonly from: "noAnswer" };

/** The stage a request was sent by. */
export type Stage = "safetyRead" | "decide" | "compose";

/** One request the transport got, and how it was answered. */
export interface WireCall {
  readonly stage: Stage;
  readonly model: string;
  /** False for a try that got no answer (it timed out). */
  readonly answered: boolean;
  /** What the answer reported (T-364's fake: Anthropic's prompt-cache rules); null when there was no answer. */
  readonly usage: FakeUsage | null;
  readonly source: Source;
}

/** What the whole run asked of the double and sent over the transport, and every request it held no answer for. */
export class RunLog {
  readonly doubleCalls: DoubleCall[] = [];
  readonly wire: WireCall[] = [];
  readonly misses: string[] = [];
}

/** One answer of the double, with the logged call it came from. */
export interface Asked {
  readonly answer: JsonObject;
  readonly source: Source;
}

/** The double, every call logged with the double's own request key before it is answered. */
export class LoggedDouble {
  constructor(
    private readonly log: RunLog,
    private readonly model: RecordedModel,
    private readonly composer: RecordedComposer,
  ) {}

  private called(kind: DoubleKind, request: unknown): Source {
    const call: DoubleCall = { kind, key: requestKey(kind, request) };
    this.log.doubleCalls.push(call);
    return { from: "double", call };
  }

  /** The safety read of one raw text. */
  async safetyRead(text: string): Promise<Asked> {
    const source = this.called("safetyRead", { text });
    return { answer: await this.model.safetyRead({ text }), source };
  }

  /** One decide read of a context, in its role; `from` is another double built by the same loader (default: this one). */
  async decide(context: unknown, role: DecideRole, from: RecordedModel = this.model): Promise<Asked> {
    const source = this.called("decideRead", { context, role });
    return { answer: await from.decide({ context: context as JsonObject, role }), source };
  }

  /** The planner's answer for a context. */
  async planner(context: unknown): Promise<Asked> {
    const source = this.called("plannerOutput", { context });
    return { answer: await this.model.planner({ context: context as JsonObject }), source };
  }

  /** The composer's plan for one outbox row's input. */
  async composerPlan(input: ComposeInput): Promise<Asked> {
    const source = this.called("composerPlan", input);
    return { answer: await this.composer.composer(input as unknown as JsonObject), source };
  }
}

// ---- The transport ----------------------------------------------------------------------------------------------------

/** One stage's transport for one run: its fetch, and `finish`, which hands its calls to the run's log. */
export interface Transport {
  readonly fetch: FetchLike;
  /** The calls this transport got, in the order they were sent, added once to the run's log. */
  finish(): WireCall[];
}

/** What a request is answered with, or why the run holds no answer for it. */
export type Answering = { readonly output: unknown; readonly source: Source } | { readonly miss: string };

/** A transport that answers each request with `answer(body)`, over T-364's fake Messages API with its prompt cache. */
export function answering(stage: Stage, log: RunLog, answer: (body: Raw) => Answering): Transport {
  const sources: Source[] = [];
  const api = fakeCachingApi({
    answer: (body, n) => {
      const found = answer(body);
      if ("miss" in found) {
        log.misses.push(`${stage}: ${found.miss}`);
        throw new Error(found.miss);
      }
      sources[n] = found.source;
      return found.output;
    },
  });
  let finished: WireCall[] | null = null;
  return {
    fetch: api.fetch,
    finish(): WireCall[] {
      if (finished !== null) return finished;
      finished = api.calls.map((call, n): WireCall => {
        const source = sources[n];
        if (source === undefined) throw new Error(`${stage}: call ${String(n)} was never answered`);
        return { stage, model: call.model, answered: call.status === 200, usage: call.usage, source };
      });
      log.wire.push(...finished);
      return finished;
    },
  };
}

/** A transport whose every request gets no answer until the caller gives up on it, as a model that times out. */
export function hanging(stage: Stage, log: RunLog): Transport {
  const calls: WireCall[] = [];
  const fetch: FetchLike = (_url, init) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Raw;
    calls.push({
      stage,
      model: typeof body.model === "string" ? body.model : "",
      answered: false,
      usage: null,
      source: { from: "noAnswer" },
    });
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new Error("aborted: no answer"));
      });
    });
  };
  let finished = false;
  return {
    fetch,
    finish(): WireCall[] {
      if (!finished) log.wire.push(...calls);
      finished = true;
      return [...calls];
    },
  };
}

/** The safety read's transport: each request answered with `served` when it reads exactly `text`. */
export function safetyTransport(
  log: RunLog,
  text: string,
  served: { readonly output: unknown; readonly source: Source },
): Transport {
  return answering("safetyRead", log, (body) =>
    textOfTurn(userOf(body)) === text ? served : { miss: "a safety read of a text the run did not ask for" },
  );
}

/** One read's answers in the two-step wire form (decide/test-support twoStep), and where they came from. */
export interface Served {
  readonly steps: StepAnswers;
  readonly source: Source;
}

/** The answer to one request from a read's two-step answers, or undefined when the read has none for that step. */
function stepAnswer(steps: StepAnswers, body: Raw): unknown {
  const step = stepOf(body);
  if (step.n === 1) return steps.step1;
  return steps.step2[step.part - 1] ?? undefined;
}

/** Decide's transport for one turn: its two reads, then the one re-read once `rereadWith` names it. */
export interface DecideTransport extends Transport {
  /** From now on every request is the turn's re-read, answered from `served`. */
  rereadWith(served: Served): void;
}

/**
 * Decide's transport for one turn routed as `route`: each request answered from the read it is for, told by the order
 * its per-turn part lists the choices in (each read's own seed's order, T-363). With one choice both reads list it
 * alike, so both reads' requests are the same and both must give the same answer, or the request is a miss. Once
 * `rereadWith` is called, every request is the re-read's, which runs only after both reads are back.
 */
export function decideTransport(
  log: RunLog,
  route: TurnRoute,
  reads: { readonly first: Served; readonly check: Served },
): DecideTransport {
  let reread: Served | null = null;
  const transport = answering("decide", log, (body): Answering => {
    let candidates: Served[];
    if (reread !== null) {
      candidates = [reread];
    } else {
      const order = choiceIdsOf(userOf(body)).join(" ");
      const [first, check] = route.reads;
      candidates = [];
      if (order === first.choiceOrder.join(" ")) candidates.push(reads.first);
      if (order === check.choiceOrder.join(" ")) candidates.push(reads.check);
    }
    const [served] = candidates;
    if (served === undefined) return { miss: "a decide request lists the choices in neither read's order" };
    const outputs = candidates.map((candidate) => stepAnswer(candidate.steps, body));
    const [output] = outputs;
    if (output === undefined) return { miss: "a decide request for a step its read does not have" };
    if (new Set(outputs.map((each) => canonicalJson(each ?? null))).size !== 1)
      return { miss: "a request both reads send, which the two reads answer differently" };
    return { output, source: served.source };
  });
  return {
    ...transport,
    rereadWith(served: Served): void {
      reread = served;
    },
  };
}

/** One outbox row's input and the plan the composer's call is answered with. */
export interface Row {
  readonly input: ComposeInput;
  readonly output: unknown;
  readonly source: Source;
}

/** The composer's transport: each request answered with the plan of the row whose tagged input is its user message. */
export function composeTransport(log: RunLog, rows: readonly Row[]): Transport {
  const byTurn = new Map(rows.map((row) => [composeInputText(row.input), row]));
  return answering("compose", log, (body) => {
    const row = byTurn.get(userOf(body));
    return row === undefined
      ? { miss: "a compose request for a row the run holds no plan for" }
      : { output: row.output, source: row.source };
  });
}
