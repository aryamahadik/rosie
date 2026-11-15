// Staging's bundle-backed safety lines (the D-017 path audit's P3b: ops/reviews/D-017-path-audit/order_d017.txt line 34;
// T-1397; the lead's notes DL-341, DL-351, DL-757 and DL-761; T-1242's architect's note N3). T-1257 made this file with
// its final signature; T-1397 binds it, and edits beside it only its ruled seam (DL-757 option (c): ../real.ts
// realSafetyRead and ../root.ts composeRoot's safetyRead input).
//
// It makes the one BundleSafety adapter (../real.ts BundleSafetyLines: fixedLine, outcomeLine and dangerWords, with
// checkPin), which ./options.ts puts in two places, so neither is edited for it:
//   - RootOptions.bundleSafety, which the root hooks at the pin (../root.ts Root.pin: checkedPin, where the state reads bind
//     real), awaits at each safety read for the bundle its text names (option (c)), and reads as the safety read's lines
//     and danger words (../real.ts realStateReads);
//   - the gate's SafetyDeps.words (./tool-api-gate.ts, T-1398: one source of the fixed lines' words; actions ports.ts
//     SafetyWords).
//
// The check (checkPin). It reads the asked bundle's manifest and every flow graph the manifest lists, as the pin reads
// them (../../bundle/values.ts: the actor's BUNDLES KV first, then PostgreSQL's copy through the request's bundle port,
// each value checked against the bundle id and the manifest's listing), and refuses the bundle, naming the failed checks'
// labels only, when:
//   - its safetyEmergency, safetyCrisis or safetyAsk fixed line has no words (DL-341; QUESTIONS.md CQ-163 (d)): no line of
//     that id with status asWritten and a text (the rule @rosie/actions' heldFixedLines applies, turn-face/commit.ts, so
//     the actor's lines and the core's choice rest on one rule), in English and not blank (below);
//   - it holds A3-49's step (DL-351; CQ-170 (2)): K-01 v1 names no hotline (neither contracts/bundle's README nor its
//     schema holds the word), so no checked line of that step can hold one, and every bundle that holds the step is
//     refused until a K-01 version names it (DL-757, question 2). A bundle that holds no such step passes: there the
//     actor's line falls to K-01's 911 (../../safety/rules.ts FIXED_LINE_OF) as the core's does (T-1162), so the two
//     cannot differ. A3-49's step is the step of that id, a step that names it as its twin (K-01 v1 step.text: "a flow B
//     step names its flow A twin"), and the step a flow's danger check gives the outcome "Harm to a child or older adult"
//     (flow B's B3-31), so the same holds for flow B.
// A bundle it passes is kept with its lines, by bundle id, the two newest at most. A bundle already kept passes at once,
// with nothing read: a bundle id's keys are written once and never overwritten (K-01 v1 "Storage"). A check whose read
// fails (a lost connection, PostgreSQL's copy missing, a value that is not the bundle's own) rejects and keeps nothing,
// so the pin fails as for any read (../../bundle/pin.ts readActive). Each caller's check makes its own reads: a read in
// flight is never shared between callers, since two handles' actors run in two request contexts.
//
// The three synchronous reads (T-1242's note N3) answer only from a bundle this adapter's own check passed: the one whose
// check passed last, a bundle already kept among them, so after a switch they answer for the newer bundle, and after a
// switch back for the older again. The adapter names that bundle (answersFor; `answers_for` on its log line). Before any
// check passed in the isolate each read throws NoStateReadError naming the read, exactly as a null input does (../real.ts
// realStateReads): the actor applies its no-verdict rule.
//   fixedLine(id)        the line's id and words when the bundle holds words for it, else null (a pendingJay line, a
//                        line the bundle lacks).
//   outcomeLine(outcome) the outcome step's checked line as K-01 v1 writes it in the flow graph: the danger check of a
//                        flow (A3-22, or B3-17: K-02 v1 safetyOutcome) is a split whose branches are the outcomes, word
//                        for word ($defs/branch `label`), each naming its step ($defs/branch `steps`); the step's line
//                        is its `say` ($defs/step `say`, $defs/message), the first message from Rosie (`from` san) to
//                        someone other than the owner, as T-1143 reads it (../../safety/partial-bundle.test.ts), under
//                        the step's id. It is used only as written: where its `text` and `plainText` are the same words,
//                        hold no slot and are not blank; anything else is null, as a step the bundle does not hold is,
//                        and the actor falls to K-01's fixed line (../../safety/rules.ts). Flow A's step first, then
//                        flow B's. Bundle v0 holds no such step: null for every outcome.
//   dangerWords()        the bundle's danger words. K-01 v1's shared lists hold none (contracts/bundle README), so []
//                        until T-1087's K-01 v1.1 (CQ-131 (b): the read lifts nothing; its own labels still decide).
//
// Which lines hold words (fixedLinesWithWords, the one rule P3b and P4a share: critic_collisions N3): heldFixedLines'
// rule, narrowed twice so no line without words can pass. English only (`lang` en: SafetyWords.fixedLine answers "in
// English", and K-01 v1 adds another language as its own line with its `lang`), and not blank (K-01 v1 refuses an empty
// text; a text of spaces is no words). So every line this adapter holds, the core holds too.
//
// What is logged: one JSON line for each check that read a bundle or changed the bundle the reads answer for
// (bundleSafetyCheck), as ./part.ts writes a database call's (DL-760). K-08 v1 names no hop for the check and the pin's
// request carries no trace, so it is no span of a trace. It holds the bundle id, the failed checks' labels, where each
// part came from, a failed read's code, call name and SQLSTATE, and the bundle the reads answer for: labels and numbers
// only, never a line's words, a danger word or any other value of a bundle.
//
// Built only where ./options.ts builds staging's inputs, and only over bound bundle reads: with P2b's bundle reads null
// (./k05-turn.ts, until T-1395) there is no bundle to read, so it is null, as the Worker's root has always handed: each
// line read throws NoStateReadError and the pin refuses every bundle (../real.ts checkedPin). Production builds none
// (./options.ts), and its pin reads the closed bundle port. Nothing here reads a binding but BUNDLES, at each check.

import {
  BundleError,
  type BundleDeps,
  type BundleErrorCode,
  type BundleKv,
  type BundleRegistry,
  type FlowGraph,
  type FlowLetter,
  type PartRead,
} from "../../bundle/types";
import { asListed, BundleReader, flowOf, readManifest, sameBundle } from "../../bundle/values";
import type { CheckedLine, DangerWordEntry } from "../../safety/types";
import { isLabel, type BundleId } from "../../trace";
import { NoStateReadError, type BundleReadCalls, type BundleSafetyLines } from "../real";
import type { StagingPart } from "./part";

/** What T-1397's builder is handed: the env, the root's handle, the actor's BUNDLES KV and P2b's bundle reads. */
export interface BundleSafetyPart extends StagingPart {
  /** The actor's BUNDLES KV, read from the env at each call; null where the env binds none. */
  readonly kv: () => BundleKv | null;
  /** P2b's bundle reads (./k05-turn.ts), as ./options.ts got them: null until T-1395 binds them. */
  readonly bundleReads: BundleReadCalls | null;
}

// ---- which fixed lines hold words -------------------------------------------------------------------------------------

/** The safety lines a bundle must hold words for to be pinned (DL-341), in the order their checks are named. */
export const REQUIRED_SAFETY_LINES = ["safetyEmergency", "safetyCrisis", "safetyAsk"] as const;

/** The label of each check a bundle can fail: a name, never a value of the bundle. */
export const BUNDLE_CHECKS = {
  safetyEmergency: "safetyEmergencyWords",
  safetyCrisis: "safetyCrisisWords",
  safetyAsk: "safetyAskWords",
  /** DL-351: the bundle holds A3-49's step, whose line can hold no hotline in K-01 v1. */
  hotline: "harmStepHotline",
} as const;

/** The language the fixed lines' words are read in (SafetyWords.fixedLine: "in English"). */
const LINE_LANGUAGE = "en";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * K-01 v1's fixed lines a manifest holds words for, by id, each with its words (the top of this file: the rule
 * @rosie/actions' heldFixedLines applies, in English and not blank). The first such line of an id is the id's.
 */
export function fixedLinesWithWords(manifest: unknown): ReadonlyMap<string, CheckedLine> {
  const lists = isRecord(manifest) && isRecord(manifest.lists) ? manifest.lists : {};
  const fixedLines = isRecord(lists.fixedLines) ? lists.fixedLines : {};
  const lines: unknown[] = Array.isArray(fixedLines.lines) ? fixedLines.lines : [];
  const held = new Map<string, CheckedLine>();
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const { id, status, text, lang } = line;
    if (typeof id !== "string" || status !== "asWritten" || typeof text !== "string") continue;
    if (lang !== LINE_LANGUAGE || text.trim() === "" || held.has(id)) continue;
    held.set(id, { id, text });
  }
  return held;
}

// ---- the outcome steps of a flow graph --------------------------------------------------------------------------------

/** Each flow's danger check, whose branches are K-02 v1's outcomes word for word ("the 8 outcomes of A3-22 and B3-17"). */
const DANGER_CHECK: Readonly<Record<FlowLetter, string>> = { A: "A3-22", B: "B3-17" };

/** The outcome whose step gives a hotline (A3-49; K-02 v1 safetyOutcome). */
const HARM_OUTCOME = "Harm to a child or older adult";
/** That step in flow A, which a flow B twin names in its `text`. */
const HARM_STEP = "A3-49";

/** Rosie's lane, and the owner's (K-01 v1 $defs/lane). */
const ROSIE = "san";
const OWNER = "owner";
/** How a message names a slot (K-01 v1 $defs/message text: "{{svc.intext:Skin fade}}"). */
const SLOT = "{{";

/** A flow graph's steps by id (K-01 v1 $defs/flowGraph `steps`); none when the graph holds none. */
function stepsOf(graph: FlowGraph): Readonly<Record<string, unknown>> {
  return isRecord(graph.steps) ? graph.steps : {};
}

/** The steps a flow's danger check gives each outcome, by the branch's label as written. */
function outcomeSteps(graph: FlowGraph, flow: FlowLetter): Map<string, string[]> {
  const steps = stepsOf(graph);
  const check = Object.hasOwn(steps, DANGER_CHECK[flow]) ? steps[DANGER_CHECK[flow]] : undefined;
  const branches: unknown[] = isRecord(check) && Array.isArray(check.branches) ? check.branches : [];
  const named = new Map<string, string[]>();
  for (const branch of branches) {
    if (!isRecord(branch) || typeof branch.label !== "string" || named.has(branch.label)) continue;
    const ids: unknown[] = Array.isArray(branch.steps) ? branch.steps : [];
    named.set(
      branch.label,
      ids.filter((id): id is string => typeof id === "string"),
    );
  }
  return named;
}

/** True when the flow graph holds A3-49's step (the top of this file): by its id, as a twin's name, or as the check's. */
function holdsHarmStep(graph: FlowGraph, flow: FlowLetter): boolean {
  const steps = stepsOf(graph);
  if (Object.hasOwn(steps, HARM_STEP)) return true;
  if (Object.values(steps).some((step) => isRecord(step) && step.text === HARM_STEP)) return true;
  return (outcomeSteps(graph, flow).get(HARM_OUTCOME) ?? []).some((id) => Object.hasOwn(steps, id));
}

/** A step's checked line as it may be sent as written (the top of this file), or null. */
function checkedLineOf(stepId: string, step: unknown): CheckedLine | null {
  const say: unknown[] = isRecord(step) && Array.isArray(step.say) ? step.say : [];
  const message = say.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      candidate.from === ROSIE &&
      typeof candidate.to === "string" &&
      candidate.to !== OWNER,
  );
  if (message === undefined) return null;
  const { text, plainText } = message;
  if (typeof text !== "string" || text !== plainText) return null;
  if (text.trim() === "" || text.includes(SLOT)) return null;
  return { id: stepId, text };
}

/** Each outcome's checked line in the flow graphs given, flow A's before flow B's, by the outcome as written. */
function outcomeLinesOf(graphs: readonly (readonly [FlowLetter, FlowGraph])[]): Map<string, CheckedLine> {
  const lines = new Map<string, CheckedLine>();
  for (const [flow, graph] of graphs) {
    const steps = stepsOf(graph);
    for (const [outcome, ids] of outcomeSteps(graph, flow)) {
      const [stepId] = ids;
      if (lines.has(outcome) || stepId === undefined || !Object.hasOwn(steps, stepId)) continue;
      const line = checkedLineOf(stepId, steps[stepId]);
      if (line !== null) lines.set(outcome, line);
    }
  }
  return lines;
}

// ---- the check's answers ----------------------------------------------------------------------------------------------

/** A bundle the check refused: the failed checks' labels (BUNDLE_CHECKS), in order, and nothing else of the bundle. */
export class BundleRefusedError extends Error {
  readonly checks: readonly string[];

  constructor(checks: readonly string[]) {
    super(`the bundle's safety lines' check refused the bundle: ${checks.join(", ")}`);
    this.name = "BundleRefusedError";
    this.checks = [...checks];
  }
}

/**
 * A bundle the check could not read: the bundle reads' own code (../../bundle/types.ts BundleErrorCode) and, where the
 * failed K-05 read named them, its call and SQLSTATE. Never a key, a host, a user or any value read.
 */
export class BundleUnreadableError extends Error {
  readonly code: BundleErrorCode;
  readonly call: string | null;
  readonly sqlstate: string | null;

  constructor(code: BundleErrorCode, call: string | null, sqlstate: string | null) {
    const named = [call, sqlstate === null ? null : `SQLSTATE ${sqlstate}`].filter((part) => part !== null);
    super(
      `the bundle's safety lines could not be read: ${code}${named.length === 0 ? "" : ` (${named.join(", ")})`}`,
    );
    this.name = "BundleUnreadableError";
    this.code = code;
    this.call = call;
    this.sqlstate = sqlstate;
  }
}

/** How a check ended, on its log line. */
export type BundleCheckOutcome =
  /** The bundle was read and passed both checks: kept, and the reads answer for it. */
  | "passed"
  /** The bundle was kept already, and the reads answer for it again (nothing read). */
  | "answering"
  /** The bundle was read and failed a check: not kept. */
  | "refused"
  /** The bundle could not be read: not kept. */
  | "unreadable";

/** One check's log line (the top of this file): labels and numbers only. */
export interface BundleSafetyCheckLine {
  readonly level: "info" | "error";
  readonly msg: "bundleSafetyCheck";
  /** The bundle the check was asked about (K-01's bundle id: a hash and a build number). */
  readonly bundle_id: BundleId;
  readonly outcome: BundleCheckOutcome;
  /** A refused bundle's failed checks (BUNDLE_CHECKS), in order; else none. */
  readonly checks: readonly string[];
  /** An unreadable bundle's code; else null. */
  readonly error_code: BundleErrorCode | null;
  /** The K-05 read that failed and its SQLSTATE, where the read named them; else null. */
  readonly call: string | null;
  readonly sqlstate: string | null;
  /** Each part the check read, in order (manifest, flow/A, ...), and where it came from (kv or postgres). */
  readonly parts: readonly string[];
  readonly from: readonly PartRead["from"][];
  /** The bundle the three reads answer for once the check ended; null while no check has passed. */
  readonly answers_for: BundleId | null;
  readonly environment: string;
  readonly version: string;
}

/** The bundle-backed adapter, which also names the bundle its reads answer for. */
export interface BundleBackedLines extends BundleSafetyLines {
  /** The bundle the three reads answer for: the one whose check passed last. Null while no check has passed. */
  answersFor(): BundleId | null;
}

export interface BundleBackedOptions {
  /** Where each check's line goes: one JSON line on console.log (Workers Logs), as every span goes. */
  readonly write?: (line: string) => void;
}

/** How many bundles' lines are kept: the two newest (a switch has the earlier bundle's texts and the newer's). */
export const KEPT_BUNDLES = 2;

/** K-01 v1's shared lists hold no danger words (contracts/bundle README; CQ-131 (b)). */
const NO_DANGER_WORDS: readonly DangerWordEntry[] = Object.freeze([]);

const SQLSTATE = /^[0-9A-Z]{5}$/u;

/** One bundle the check passed: its id and the lines the reads answer with. */
interface KeptBundle {
  readonly bundleId: BundleId;
  readonly fixed: ReadonlyMap<string, CheckedLine>;
  readonly outcomes: ReadonlyMap<string, CheckedLine>;
}

/** The K-05 read a check's failure came from: its call and SQLSTATE, as labels, where the read named them. */
interface FailedRead {
  call: string | null;
  sqlstate: string | null;
}

const idOf = (bundleId: BundleId): BundleId => ({ hash: bundleId.hash, build: bundleId.build });

/** A K-01 v1 key's part: what follows bundle/<hash>/<build>/. */
const partOf = (key: string): string => key.split("/").slice(3).join("/");

const sqlstateOf = (value: unknown): string | null =>
  typeof value === "string" && SQLSTATE.test(value) ? value : null;

/**
 * The bundle port's registry, noting the call and SQLSTATE of a readBundleValue that fails or answers transient: the
 * call's name as the error names it (db/repo's DataAccessDatabaseError and the handle's errors carry `call`), else K-05's
 * own, and the error's code where it is an SQLSTATE. Never its message. Every answer and error goes on as it came.
 */
function noting(registry: BundleRegistry, failed: FailedRead): BundleRegistry {
  return {
    readActiveBundle: (request) => registry.readActiveBundle(request),
    async readBundleValue(request) {
      try {
        const answer: unknown = await registry.readBundleValue(request);
        if (isRecord(answer) && answer.error === "transient") {
          failed.call = "readBundleValue";
          failed.sqlstate = sqlstateOf(answer.sqlstate);
        }
        return answer as Awaited<ReturnType<BundleRegistry["readBundleValue"]>>;
      } catch (error) {
        const thrown: Record<string, unknown> = isRecord(error) ? error : {};
        failed.call = isLabel(thrown.call) ? thrown.call : "readBundleValue";
        failed.sqlstate = sqlstateOf(thrown.code);
        throw error;
      }
    },
  };
}

/**
 * The bundle-backed BundleSafety adapter over `part` (the top of this file). One instance holds the bundles its own check
 * passed for its isolate; ./options.ts makes one per root.
 */
export function bundleBackedSafety(
  part: BundleSafetyPart,
  options: BundleBackedOptions = {},
): BundleBackedLines {
  const write =
    options.write ??
    ((line: string) => {
      console.log(line);
    });
  /** The bundles the check passed, the one that answers last. */
  const kept: KeptBundle[] = [];

  const answering = (): KeptBundle | null => kept[kept.length - 1] ?? null;

  const log = (
    bundleId: BundleId,
    outcome: BundleCheckOutcome,
    rest: Partial<Pick<BundleSafetyCheckLine, "checks" | "error_code" | "call" | "sqlstate">>,
    reads: readonly PartRead[],
  ): void => {
    const line: BundleSafetyCheckLine = {
      level: outcome === "passed" || outcome === "answering" ? "info" : "error",
      msg: "bundleSafetyCheck",
      bundle_id: idOf(bundleId),
      outcome,
      checks: rest.checks ?? [],
      error_code: rest.error_code ?? null,
      call: rest.call ?? null,
      sqlstate: rest.sqlstate ?? null,
      parts: reads.map((read) => partOf(read.key)),
      from: reads.map((read) => read.from),
      answers_for: answering()?.bundleId ?? null,
      environment: part.env.ENVIRONMENT,
      version: part.env.GIT_SHA ?? "unknown",
    };
    try {
      write(JSON.stringify(line));
    } catch {
      // No line for this check; the check's answer stands.
    }
  };

  /** Makes `bundle` the one the reads answer for, kept with the newest before it. */
  const admit = (bundle: KeptBundle): void => {
    const at = kept.findIndex((known) => sameBundle(known.bundleId, bundle.bundleId));
    if (at !== -1) kept.splice(at, 1);
    kept.push(bundle);
    while (kept.length > KEPT_BUNDLES) kept.shift();
  };

  /** Reads the bundle and holds it to both checks: its lines, or a throw (BundleRefusedError, BundleUnreadableError). */
  const check = async (bundleId: BundleId, bundles: BundleDeps): Promise<KeptBundle> => {
    const failed: FailedRead = { call: null, sqlstate: null };
    let reader: BundleReader | null = null;
    let fixed: ReadonlyMap<string, CheckedLine>;
    const graphs: (readonly [FlowLetter, FlowGraph])[] = [];
    try {
      const reading = new BundleReader(noting(bundles.registry, failed), bundles.kv ?? part.kv());
      reader = reading;
      const manifest = await readManifest(reading, bundleId);
      fixed = fixedLinesWithWords(manifest);
      for (const listed of manifest.storage.values) {
        const flow = listed.flow;
        if (listed.kind !== "flow" || flow === undefined) continue;
        const graph = await reading.read(listed.key, "flow", (value) =>
          Promise.resolve(asListed(value, listed) ? flowOf(value.text, flow) : null),
        );
        graphs.push([flow, graph]);
      }
    } catch (error) {
      const code = error instanceof BundleError ? error.code : "noAnswer";
      log(
        bundleId,
        "unreadable",
        { error_code: code, call: failed.call, sqlstate: failed.sqlstate },
        reader?.reads() ?? [],
      );
      throw new BundleUnreadableError(code, failed.call, failed.sqlstate);
    }
    const reads = reader.reads();
    graphs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const refused: string[] = REQUIRED_SAFETY_LINES.filter((id) => !fixed.has(id)).map(
      (id) => BUNDLE_CHECKS[id],
    );
    if (graphs.some(([flow, graph]) => holdsHarmStep(graph, flow))) refused.push(BUNDLE_CHECKS.hotline);
    if (refused.length > 0) {
      log(bundleId, "refused", { checks: refused }, reads);
      throw new BundleRefusedError(refused);
    }
    const passed: KeptBundle = { bundleId: idOf(bundleId), fixed, outcomes: outcomeLinesOf(graphs) };
    admit(passed);
    log(bundleId, "passed", {}, reads);
    return passed;
  };

  /** The bundle the reads answer from, or a throw naming the read while no check has passed. */
  const answeringFor = (read: string): KeptBundle => {
    const bundle = answering();
    if (bundle === null) throw new NoStateReadError(read);
    return bundle;
  };

  const copyOf = (line: CheckedLine | undefined): CheckedLine | null =>
    line === undefined ? null : { id: line.id, text: line.text };

  return {
    async checkPin(request) {
      const bundleId = idOf(request.bundleId);
      const known = kept.find((bundle) => sameBundle(bundle.bundleId, bundleId));
      if (known === undefined) {
        await check(bundleId, request.bundles);
        return;
      }
      // Kept already: nothing is read, and the reads answer for it (again, after a switch back).
      const before = answering();
      admit(known);
      if (before !== known) log(bundleId, "answering", {}, []);
    },
    fixedLine: (id) => copyOf(answeringFor("fixedLine").fixed.get(id)),
    outcomeLine: (outcome) => copyOf(answeringFor("outcomeLine").outcomes.get(outcome)),
    dangerWords() {
      answeringFor("dangerWords");
      return NO_DANGER_WORDS;
    },
    answersFor() {
      const bundle = answering();
      return bundle === null ? null : idOf(bundle.bundleId);
    },
  };
}

/**
 * The bundle a BundleSafety adapter's reads answer for, where the adapter names it (this file's does): its K-01 bundle
 * id, or null while no check has passed, for an adapter that names none, and for none at all.
 */
export function answeringBundleOf(lines: BundleSafetyLines | null): BundleId | null {
  if (lines === null || !("answersFor" in lines)) return null;
  const named = lines as Partial<BundleBackedLines>;
  return typeof named.answersFor === "function" ? named.answersFor() : null;
}

/**
 * RootOptions.bundleSafety for staging, the one adapter instance, over P2b's bundle reads; null while those are null (no
 * bundle can be read: every line read fails closed and the pin refuses every bundle, as with nothing bound).
 */
export const stagingBundleSafety: (part: BundleSafetyPart) => BundleSafetyLines | null = (part) =>
  part.bundleReads === null ? null : bundleBackedSafety(part);
