// Loading the composer's recordings (T-1071; T-1175): every recording is resolved, checked against the K-03 version its
// file names and keyed by its input, and the files are refused whole (nothing loads) when any one recording fails. They
// sit in their own files, because the composer is K-03's and recordings.v1.json and recordings.v1.1.json are K-02's. A
// file is
//
//   { version: "v1", contract: "message-plan.v1" | "message-plan.v1.1", recordings: [...] }
//
// and its contract is the K-03 version each of its recordings is checked against: composer.v1.json holds K-03 v1's,
// composer.v1.1.json K-03 v1.1's, whose inputs carry term facts (Rosie's own fixed terms that the step's card states,
// each with its source line: README "v1.1"), which v1's schema refuses. The double loads both into one lookup. A
// recording is
//
//   { id, kind: "composerPlan", request, seed | output }
//
//   - request: the composer's input, `$defs/composeInput` of the file's version (inline), or { fixture } (a K-03 fixture
//     of the file's version or an earlier one) or { file } (a path under ai/recordings): the answer is keyed by the
//     sha256 of that input's canonical JSON, its content, never a fixture's name;
//   - seed: { fixture }, the K-03 `plan` fixture the answer comes from, of the file's version or an earlier one (every
//     plan is v1's: v1.1 leaves the plan as it is). A live recording (after J-02a) gives `output` instead, the plan as
//     the model returned it.
//
// What the loader refuses, all of it, with the recording's id in each line: a file whose contract is not a K-03 version
// the double reads; any kind but composerPlan; an input the schema refuses (a frontier field, for one, or a term fact in
// a v1 file); a plan the schema refuses ($defs/plan: a format outside the five, a {{hold}} slot); a plan whose words open
// a slot that is not in K-03's vocabulary (slots.json: 52 slots, hold refused since D66), whatever the schema's pattern
// says; a seed fixture that is not an accepted `plan` fixture of the file's version or an earlier one; two recordings
// with one input or one id, in one file or across the files loaded together.
// That a plan stays inside its input's allowed formats, links, options, page types and threads, and states no number its
// input's facts do not hold (K-03 v1.1's numbersHeldByFacts), is the composer's literal check and the message checks'
// (C-118, C-092, C-128), not this loader's: a recording of a plan that breaks them is how a test gives those checks
// something to catch (composer.v1.json's input-s1-02.json, no term facts, with plan-s1-02.json: literalValue x2).

import { readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACTS_ROOT, RECORDINGS_ROOT } from "./contract";
import { COMPOSER_KIND, type RecordedComposer, type RecordedDouble } from "./composer-types";
import { createRecordedComposer } from "./double";
import { RecordingRefusedError } from "./errors";
import { requestKey } from "./key";
import { loadPlanContract, type PlanContract, type PlanVersion } from "./plan-contract";
import {
  describe,
  isObject,
  loadRecordedModel,
  onlyKeys,
  readRecordingFile,
  type LoadOptions,
} from "./recordings";
import type { JsonObject } from "./types";

/** K-03 v1's composer recordings file, inside the recordings folder. */
export const COMPOSER_RECORDINGS_FILE = "composer.v1.json";
/** K-03 v1.1's composer recordings file (inputs with term facts: S1-02's, the JOIN run's), inside the recordings folder. */
export const COMPOSER_RECORDINGS_V1_1_FILE = "composer.v1.1.json";
/** Every composer recordings file the double loads, in this order. */
export const COMPOSER_RECORDINGS_FILES = [COMPOSER_RECORDINGS_FILE, COMPOSER_RECORDINGS_V1_1_FILE] as const;

/** A composer recordings file's `contract`, and the K-03 version its recordings are checked against. */
const FILE_CONTRACTS: ReadonlyMap<string, PlanVersion> = new Map([
  ["message-plan.v1", "v1"],
  ["message-plan.v1.1", "v1.1"],
]);
const FILE_SHAPE = `{ "version": "v1", "contract": ${[...FILE_CONTRACTS.keys()]
  .map((name) => JSON.stringify(name))
  .join(" or ")}, "recordings": [...] }`;

interface ComposerRecording {
  readonly id: string;
  readonly key: string;
  readonly output: JsonObject;
}

/** The input a request names: inline, a K-03 fixture or a file of ai/recordings. */
function resolveInput(value: unknown, contract: PlanContract, recordingsRoot: string): unknown {
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "fixture" && typeof value.fixture === "string")
      return contract.fixtures.read(value.fixture);
    if (keys.length === 1 && keys[0] === "file" && typeof value.file === "string")
      return readRecordingFile(recordingsRoot, value.file);
  }
  return value;
}

/** Every `{{` in a plan's words must open a slot of the vocabulary: one line per slot that does not. */
function slotProblems(text: string, names: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("{{", from);
    if (at < 0) return problems;
    const slot = /^\{\{([^:{}|]*)(?::[^{}|]*)?(?:\|[^{}]*)?\}\}/.exec(text.slice(at));
    if (slot === null) {
      problems.push(`the words open a {{ that is not a slot: ${JSON.stringify(text.slice(at, at + 24))}`);
      from = at + 2;
      continue;
    }
    const name = slot[1] ?? "";
    if (!names.has(name)) {
      problems.push(
        `the words name the slot {{${name}}}, which K-03's vocabulary does not hold${name === "hold" ? " (hold is refused since D66)" : ""}`,
      );
    }
    from = at + slot[0].length;
  }
}

/** Every words field of a plan that holds words: its lines' text and its question's. */
function planWords(plan: unknown): string[] {
  if (!isObject(plan)) return [];
  const words: string[] = [];
  if (Array.isArray(plan.lines)) {
    for (const line of plan.lines as unknown[]) {
      if (isObject(line) && typeof line.text === "string") words.push(line.text);
    }
  }
  if (isObject(plan.question) && typeof plan.question.text === "string") words.push(plan.question.text);
  return words;
}

type Resolved = { recording: ComposerRecording } | { problems: string[] };

function resolveRecording(
  spec: unknown,
  position: number,
  contract: PlanContract,
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
  if (spec.kind !== COMPOSER_KIND)
    return fail(
      `kind ${JSON.stringify(spec.kind)} is not ${COMPOSER_KIND}, the one kind the composer's file holds`,
    );
  if (!isObject(spec.request)) return fail("request is not an object");
  const hasSeed = spec.seed !== undefined;
  const hasOutput = spec.output !== undefined;
  if (hasSeed === hasOutput) return fail("gives exactly one of seed and output");

  // The input.
  let input: unknown;
  try {
    input = resolveInput(spec.request, contract, recordingsRoot);
  } catch (error) {
    return fail(`the request cannot be read: ${describe(error)}`);
  }
  for (const line of contract.validate("composeInput", input)) problems.push(`${id}: the input: ${line}`);
  if (problems.length > 0) return { problems };

  // The plan.
  let output: unknown;
  if (hasOutput) {
    output = spec.output;
  } else {
    const seed = spec.seed;
    if (!isObject(seed) || Object.keys(seed).length !== 1 || typeof seed.fixture !== "string")
      return fail(`seed is not { "fixture": <a K-03 ${contract.version} plan fixture file> }`);
    let fixture: unknown;
    try {
      fixture = contract.fixtures.read(seed.fixture);
    } catch (error) {
      return fail(`seed: ${describe(error)}`);
    }
    for (const line of contract.validate("plan", fixture))
      problems.push(`${id}: seed ${seed.fixture} against plan: ${line}`);
    if (problems.length > 0) return { problems };
    output = fixture;
  }

  // What the plan must satisfy, however it came.
  for (const line of contract.validate("plan", output))
    problems.push(`${id}: the answer against plan: ${line}`);
  for (const words of planWords(output)) {
    for (const line of slotProblems(words, contract.slotNames)) problems.push(`${id}: ${line}`);
  }
  if (problems.length > 0) return { problems };

  try {
    return {
      recording: { id, key: requestKey(COMPOSER_KIND, input), output: structuredClone(output as JsonObject) },
    };
  } catch (error) {
    return fail(`the input cannot be keyed: ${describe(error)}`);
  }
}

/** The K-03 version a composer recordings file is checked against, by its contract; undefined when it is not a file's shape. */
function versionOf(file: unknown): PlanVersion | undefined {
  if (!isObject(file) || file.version !== "v1" || !Array.isArray(file.recordings)) return undefined;
  return typeof file.contract === "string" ? FILE_CONTRACTS.get(file.contract) : undefined;
}

/** Every file's recordings checked by its own version, keyed together; refused whole with every problem named. */
function buildFrom(
  files: readonly (readonly [name: string | null, file: unknown])[],
  options: LoadOptions,
): RecordedComposer {
  const contractsRoot = options.contractsRoot ?? CONTRACTS_ROOT;
  const recordingsRoot = options.recordingsRoot ?? RECORDINGS_ROOT;
  const contracts = new Map<PlanVersion, PlanContract>();
  const problems: string[] = [];
  const byKey = new Map<string, ComposerRecording>();
  const ids = new Set<string>();
  for (const [name, file] of files) {
    const version = versionOf(file);
    if (version === undefined) {
      problems.push(`${name === null ? "" : `${name}: `}the file is not ${FILE_SHAPE}`);
      continue;
    }
    let contract = contracts.get(version);
    if (contract === undefined) {
      contract = loadPlanContract(contractsRoot, version);
      contracts.set(version, contract);
    }
    for (const [position, spec] of (file as { recordings: unknown[] }).recordings.entries()) {
      const resolved = resolveRecording(spec, position, contract, recordingsRoot);
      if ("problems" in resolved) {
        problems.push(...resolved.problems);
        continue;
      }
      const { recording } = resolved;
      if (ids.has(recording.id)) problems.push(`${recording.id}: the id is used twice`);
      ids.add(recording.id);
      const same = byKey.get(recording.key);
      if (same !== undefined) problems.push(`${recording.id}: has the same input as ${same.id}`);
      else byKey.set(recording.key, recording);
    }
  }
  if (problems.length > 0) throw new RecordingRefusedError(problems);
  return createRecordedComposer(byKey);
}

/**
 * Builds the composer's double from one recordings file already parsed (a test gives its own), checked against the K-03
 * version its contract names. Refuses it whole, with every problem named, when any recording fails; never loads a plan
 * the schema or the slot vocabulary refuses.
 */
export function buildRecordedComposer(file: unknown, options: LoadOptions = {}): RecordedComposer {
  return buildFrom([[null, file]], options);
}

/**
 * Builds one composer double from several recordings files already parsed, by name, each checked against the K-03
 * version its contract names. Refuses them all, with every problem named, when any recording fails, or when two
 * recordings share an input or an id across the files.
 */
export function buildRecordedComposerFromFiles(
  files: Readonly<Record<string, unknown>>,
  options: LoadOptions = {},
): RecordedComposer {
  return buildFrom(Object.entries(files), options);
}

/**
 * Loads ai/recordings/composer.v1.json and composer.v1.1.json (or those of the folder `recordingsRoot` names) into the
 * composer's double.
 */
export function loadRecordedComposer(options: LoadOptions = {}): RecordedComposer {
  const recordingsRoot = options.recordingsRoot ?? RECORDINGS_ROOT;
  const files: Record<string, unknown> = {};
  for (const name of COMPOSER_RECORDINGS_FILES)
    files[name] = JSON.parse(readFileSync(path.join(recordingsRoot, name), "utf8")) as unknown;
  return buildRecordedComposerFromFiles(files, options);
}

/**
 * Loads every file: the three K-02 reads of recordings.v1.json and recordings.v1.1.json and the composer of
 * composer.v1.json and composer.v1.1.json, as one double.
 */
export async function loadRecordedDouble(options: LoadOptions = {}): Promise<RecordedDouble> {
  const model = await loadRecordedModel(options);
  const composer = loadRecordedComposer(options);
  return {
    safetyRead: (request) => model.safetyRead(request),
    decide: (request) => model.decide(request),
    planner: (request) => model.planner(request),
    composer: (input) => composer.composer(input),
    size: model.size + composer.size,
  };
}
