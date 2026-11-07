// Loading the recordings (T-004): every recording is resolved, checked against K-02 v1 and keyed by its request, and the
// whole file is refused (nothing loads) when any one of them fails. A recording is
//
//   { id, kind, request, seed | output }
//
//   - kind: safetyRead (request { text }), decideRead (request { context, role }) or plannerOutput (request { context });
//   - request.context: a K-02 context, inline, or { fixture } (a K-02 v1 fixture) or { file } (a path under ai/recordings);
//   - seed: { fixture }, the K-02 v1 fixture the answer comes from: for safetyRead a safetyResult (its read), for
//     decideRead a decideResult (the read of the request's role), for plannerOutput a plannerOutput. A live recording
//     (after J-02a) gives `output` instead, the answer as the model returned it.
//
// What the loader refuses, all of it, with the recording's id in each line: a kind K-02 has no model-facing shape for; a
// request that is not shaped as its kind says (a context the schema refuses, an unknown role); an answer the schema
// refuses; a decide answer that breaks a named rule of model.rules.mjs against its context (optionOffered, quoteInText);
// a seed fixture that is not an accepted v1 fixture, or is for another turn or bundle than the context; a planner answer
// naming a fact the context does not hold; two recordings with one request or one id.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { CONTRACTS_ROOT, RECORDINGS_ROOT, loadModelContract, type ModelContract } from "./contract";
import { createRecordedModel } from "./double";
import { RecordingRefusedError } from "./errors";
import { requestKey } from "./key";
import {
  DECIDE_ROLES,
  RECORDING_KINDS,
  type DecideRole,
  type JsonObject,
  type RecordedModel,
  type RecordingKind,
} from "./types";

export interface Recording {
  readonly id: string;
  readonly kind: RecordingKind;
  readonly key: string;
  readonly output: JsonObject;
}

export interface LoadOptions {
  /** The contracts/ folder. Default: this repository's. */
  readonly contractsRoot?: string;
  /** The folder `{ "file" }` references and the default recordings file are relative to. Default: ai/recordings. */
  readonly recordingsRoot?: string;
}

/** The default recordings file, inside the recordings folder. */
export const RECORDINGS_FILE = "recordings.v1.json";

const OUTPUT_DEF: Record<RecordingKind, string> = {
  safetyRead: "safetyRead",
  decideRead: "decideRead",
  plannerOutput: "plannerOutput",
};
/** What a seed fixture is, by kind. */
const SEED_DEF: Record<RecordingKind, string> = {
  safetyRead: "safetyResult",
  decideRead: "decideResult",
  plannerOutput: "plannerOutput",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `holds ${extra.join(", ")}, which it does not take` : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A file under the recordings folder, by a relative path that stays inside it. */
function readRecordingFile(recordingsRoot: string, relative: string): unknown {
  const absolute = path.resolve(recordingsRoot, relative);
  if (path.relative(recordingsRoot, absolute).startsWith("..") || path.isAbsolute(relative))
    throw new Error(`the file ${relative} is outside ai/recordings`);
  return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
}

/** The context a request names: inline, a K-02 fixture or a file of ai/recordings. */
function resolveContext(value: unknown, contract: ModelContract, recordingsRoot: string): unknown {
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "fixture" && typeof value.fixture === "string")
      return contract.fixtures.read(value.fixture);
    if (keys.length === 1 && keys[0] === "file" && typeof value.file === "string")
      return readRecordingFile(recordingsRoot, value.file);
  }
  return value;
}

type Resolved = { recording: Recording } | { problems: string[] };

function resolveRecording(
  spec: unknown,
  position: number,
  contract: ModelContract,
  recordingsRoot: string,
): Resolved {
  if (!isObject(spec)) return { problems: [`recordings[${String(position)}]: is not an object`] };
  const id = typeof spec.id === "string" && spec.id !== "" ? spec.id : `recordings[${String(position)}]`;
  const problems: string[] = [];
  const fail = (line: string): { problems: string[] } => {
    problems.push(`${id}: ${line}`);
    return { problems };
  };

  const extra = onlyKeys(spec, ["id", "kind", "request", "seed", "output"]);
  if (extra !== undefined) return fail(extra);
  if (typeof spec.id !== "string" || spec.id === "") return fail("has no id");
  const kind = RECORDING_KINDS.find((candidate) => candidate === spec.kind);
  if (kind === undefined) {
    return fail(
      `kind ${JSON.stringify(spec.kind)} is not one of K-02's model-facing outputs (${RECORDING_KINDS.join(", ")})`,
    );
  }
  const req: unknown = spec.request;
  if (!isObject(req)) return fail("request is not an object");
  const hasSeed = spec.seed !== undefined;
  const hasOutput = spec.output !== undefined;
  if (hasSeed === hasOutput) return fail("gives exactly one of seed and output");

  // The request.
  let request: JsonObject;
  let context: unknown;
  let role: DecideRole | undefined;
  try {
    if (kind === "safetyRead") {
      const bad = onlyKeys(req, ["text"]);
      if (bad !== undefined) return fail(`the request ${bad}`);
      if (typeof req.text !== "string" || !/\S/.test(req.text))
        return fail("the request needs the text to read");
      request = { text: req.text };
    } else {
      const bad = onlyKeys(req, kind === "decideRead" ? ["context", "role"] : ["context"]);
      if (bad !== undefined) return fail(`the request ${bad}`);
      context = resolveContext(req.context, contract, recordingsRoot);
      for (const line of contract.validate("context", context)) problems.push(`${id}: the context: ${line}`);
      if (problems.length > 0) return { problems };
      if (kind === "decideRead") {
        role = DECIDE_ROLES.find((candidate) => candidate === req.role);
        if (role === undefined)
          return fail(`the request's role ${JSON.stringify(req.role)} is not ${DECIDE_ROLES.join(", ")}`);
        request = { context: context, role };
      } else {
        request = { context: context };
      }
    }
  } catch (error) {
    return fail(`the request cannot be read: ${describe(error)}`);
  }

  // The answer.
  let output: unknown;
  if (hasOutput) {
    output = spec.output;
  } else {
    const seed = spec.seed;
    if (!isObject(seed) || Object.keys(seed).length !== 1 || typeof seed.fixture !== "string")
      return fail('seed is not { "fixture": <a K-02 v1 fixture file> }');
    let fixture: unknown;
    try {
      fixture = contract.fixtures.read(seed.fixture);
    } catch (error) {
      return fail(`seed: ${describe(error)}`);
    }
    for (const line of contract.validate(SEED_DEF[kind], fixture))
      problems.push(`${id}: seed ${seed.fixture} against ${SEED_DEF[kind]}: ${line}`);
    if (problems.length > 0) return { problems };
    if (kind === "safetyRead") {
      output = (fixture as { read: unknown }).read;
      if (output === null) return fail(`seed ${seed.fixture} timed out: it holds no model answer to replay`);
    } else if (kind === "plannerOutput") {
      output = fixture;
    } else {
      const decide = fixture as {
        turnId: unknown;
        bundleId: unknown;
        reads: { role: string; output: unknown }[];
      };
      const { turnId, bundleId } = context as { turnId: unknown; bundleId: unknown };
      if (decide.turnId !== turnId || !isDeepStrictEqual(decide.bundleId, bundleId))
        return fail(`seed ${seed.fixture} is for another turn or bundle than the context`);
      const read = decide.reads.find((candidate) => candidate.role === role);
      if (read === undefined) return fail(`seed ${seed.fixture} holds no ${String(role)} read`);
      output = read.output;
    }
  }

  // What the answer must satisfy, however it came.
  for (const line of contract.validate(OUTPUT_DEF[kind], output))
    problems.push(`${id}: the answer against ${OUTPUT_DEF[kind]}: ${line}`);
  if (problems.length > 0) return { problems };
  if (kind === "decideRead") {
    // The two named rules run on the context with this one read as the decide result's only read.
    const pair = { context, decide: { reads: [{ output }], parts: [] } };
    for (const [name, rule] of Object.entries(contract.rules)) {
      for (const line of rule(pair)) problems.push(`${id}: rule ${name}: ${line}`);
    }
  }
  if (kind === "plannerOutput") {
    const action = (output as { action: { verb: string; facts?: string[] } }).action;
    const held = new Set((context as { facts: { name: string }[] }).facts.map((fact) => fact.name));
    for (const name of action.verb === "answer" ? (action.facts ?? []) : []) {
      if (!held.has(name))
        problems.push(`${id}: the answer names the fact ${name}, which the context does not hold`);
    }
  }
  if (problems.length > 0) return { problems };

  try {
    return {
      recording: { id, kind, key: requestKey(kind, request), output: structuredClone(output as JsonObject) },
    };
  } catch (error) {
    return fail(`the request cannot be keyed: ${describe(error)}`);
  }
}

/**
 * Builds the double from a recordings file already parsed (a test gives its own). Refuses it whole, with every problem
 * named, when any recording fails; never loads a recording the schema or a named rule refuses.
 */
export async function buildRecordedModel(file: unknown, options: LoadOptions = {}): Promise<RecordedModel> {
  const contract = await loadModelContract(options.contractsRoot ?? CONTRACTS_ROOT);
  const recordingsRoot = options.recordingsRoot ?? RECORDINGS_ROOT;
  if (
    !isObject(file) ||
    file.version !== "v1" ||
    file.contract !== "model.v1" ||
    !Array.isArray(file.recordings)
  )
    throw new RecordingRefusedError([
      'the file is not { "version": "v1", "contract": "model.v1", "recordings": [...] }',
    ]);

  const problems: string[] = [];
  const byKey = new Map<string, Recording>();
  const ids = new Set<string>();
  for (const [position, spec] of (file.recordings as unknown[]).entries()) {
    const resolved = resolveRecording(spec, position, contract, recordingsRoot);
    if ("problems" in resolved) {
      problems.push(...resolved.problems);
      continue;
    }
    const { recording } = resolved;
    if (ids.has(recording.id)) problems.push(`${recording.id}: the id is used twice`);
    ids.add(recording.id);
    const same = byKey.get(recording.key);
    if (same !== undefined) problems.push(`${recording.id}: has the same request as ${same.id}`);
    else byKey.set(recording.key, recording);
  }
  if (problems.length > 0) throw new RecordingRefusedError(problems);
  return createRecordedModel(byKey);
}

/** Loads ai/recordings/recordings.v1.json (or the folder `recordingsRoot` names) into the double. */
export async function loadRecordedModel(options: LoadOptions = {}): Promise<RecordedModel> {
  const recordingsRoot = options.recordingsRoot ?? RECORDINGS_ROOT;
  const file = JSON.parse(readFileSync(path.join(recordingsRoot, RECORDINGS_FILE), "utf8")) as unknown;
  return buildRecordedModel(file, options);
}
