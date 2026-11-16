// The parity harness (T-161; C-073): for a trade, a flow and a path, the compiler's pre-correction words held against
// the master's own functions, and those against what the master's step.js prints where its command line can say the
// path.
//
// Master Corrections section 1: before its corrections, the step compiler must give the same words as
// `cd engine && node work/build/step.js <A or B> <id> --prof <trade> --path "<path>"`, path by path; after them, only the
// lines it names may differ (that allow list is T-162's). Q-35's default: parity runs against the lib.js and
// overlay-core.js functions, path by path, with each trade's full switches and facts, since step.js --prof does not carry
// a trade's switches into --path, and --path refuses the 11 header-only facts that 207 of the 243 trades list
// (scratch/plan-work/notes/specs.md 4.3).
//
// The three sides:
//   the compiler   compilerWords(applied, path): the trade applied (T-135 applyTrade; a caller may hand in that flow with
//                  corrections laid on), the path walked (T-136 walkPath) and each message's plain text (T-134 plainText).
//   the reference  Reference: lib.js, overlay-core.js and msgtext.js of fixture set v1 (T-130) loaded again, on a copy of
//                  their own, and run as step.js runs them: CORE.apply() on master-<flow>.json and prof/<trade>.json as
//                  they are; the trade's paths from lib.js pathsFor() with its own switches and facts (as T-136 makes
//                  them); each step's words from resolveVary(), its messages from smsText(), its branches from lit().
//                  It shares no object or loaded script with the compiler side.
//   step.js        stepJsPath() writes a reference path the way step.js --path reads it, where lib.js parsePath() gives
//                  back that very path; runStepJs() runs the master copy's step.js; compareStepJs() holds the `- on`
//                  block step.js prints for each step against the reference's words. The master copy is outside git
//                  (scratch/master-copy, never in CI): findMasterCopy() finds it, masterCopyDiffers() checks that it
//                  reads fixture set v1's inputs byte for byte.
//
// The words compared, for each step the path lights, are the ones step.js --path prints (step.js lines 78-87): `does`,
// `more`, `say` as plain text, `form`, `rule`, the branches lit on the path, and the vary keys that chose them. The walk
// is lib.js litSteps'. By default each step is read with the walked path alone and the opt-out marker stays as written,
// which is how step.js prints a step; WordsOptions follow a branch's `sets` (litSteps' own walk) or settle the marker
// (applyStops over firstTexts of the walked path, as walkPath does by default). compareWords() and compareStepJs() list
// every difference with its trade, flow, path, step and field.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowLetter, Message } from "../graph/types.ts";
import { plainText } from "../msgtext";
import type { AppliedStep, AppliedTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { lit, pathName, walkPath, type TradePath } from "../path";

type Obj = Record<string, unknown>;

/** The repository's root folder: this checkout. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Fixture set v1's copy of the master's engine/ folder (T-130), which both the compiler and the reference read. */
export const FIXTURE_ENGINE = fileURLToPath(new URL("../../../fixtures/master/engine/", import.meta.url));

// ---- what is compared --------------------------------------------------------------------------------------------

/** A field of the words compared, or `step` (a step lit on one side only, or out of order) and `path` (no such path). */
export type WordField = "path" | "step" | "keys" | "does" | "more" | "say" | "form" | "rule" | "branches";

/** A branch lit on the path (its `when` fits). */
export interface BranchWords {
  label: string;
  /** The words of its ending, where the branch ends the flow (`end: "end"`); else null. */
  ends: string | null;
  /** The reason of the `off` op that switched it off; else null. step.js prints such a branch lit all the same. */
  off: string | null;
}

/** One step as the path shows it: what step.js --path prints for it. */
export interface StepWords {
  id: string;
  /** The path as this step reads it, by its name (lib.js pathName): the walked path, or the path after a branch's `sets`. */
  reading: string;
  /** The vary keys that chose the words, in the order applied; none for the base words. */
  keys: string[];
  does: string | null;
  more: string[];
  /** Each message as `<from> → <to>: <its plain text>` (msgtext.js smsText). */
  say: string[];
  /** Each screen row as `<label>: <value>`. */
  form: string[];
  rule: string | null;
  branches: BranchWords[];
}

/** Every step one path lights in one trade's flow, in walk order. */
export interface PathWords {
  trade: string;
  flow: FlowLetter;
  /** The walked path's name (lib.js pathName). */
  path: string;
  steps: StepWords[];
}

/** One difference: where it is, and the words on each side. */
export interface WordDifference {
  trade: string;
  flow: FlowLetter;
  path: string;
  /** The step's id; empty for a `path` difference. */
  step: string;
  field: WordField;
  /** The line, message, row or branch within the field (from 0); null for a field with one value. */
  index: number | null;
  /** Whose words were held against the reference's: the compiler's, or step.js's printout. */
  side: "compiler" | "step.js";
  /** That side's words; null where it has none. */
  got: string | null;
  /** The reference's words; null where it has none. */
  want: string | null;
}

/** How a path is read. */
export interface WordsOptions {
  /** false (the default): every step read with the walked path alone, as step.js --path reads it; true: a branch's `sets` followed (lib.js litSteps). */
  sets?: boolean;
  /** "asWritten" (the default): the opt-out marker as written, as step.js prints it; "settled": applyStops over firstTexts of the walked path. */
  stops?: "asWritten" | "settled";
}

/** The part of a step whose words are compared. */
interface WordsSource {
  does?: unknown;
  more?: unknown;
  say?: unknown;
  form?: unknown;
  rule?: unknown;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/**
 * A value step.js prints only when it is truthy (`if (w.does)`): the text, or null. A truthy value that is not a text
 * (none is in the master or the trades) is written as JSON on both sides, so the two sides still compare it.
 */
function shown(value: unknown): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Element `k` of a row or message, as `r[k]` reads it. */
function part(value: unknown, k: number): unknown {
  return value === null || value === undefined ? undefined : (value as Record<number, unknown>)[k];
}

/** The words of a step, read as step.js prints them; `sms` writes a message's plain text. */
function wordsOf(
  step: WordsSource,
  sms: (message: unknown[]) => string,
): Omit<StepWords, "id" | "reading" | "keys" | "branches"> {
  return {
    does: shown(step.does),
    more: list(step.more).map(String),
    say: list(step.say).map(
      (message) => `${String(part(message, 0))} → ${String(part(message, 1))}: ${sms(list(message))}`,
    ),
    form: list(step.form).map((row) => `${String(part(row, 0))}: ${String(part(row, 1))}`),
    rule: shown(step.rule),
  };
}

function branchWords(branch: {
  label: string;
  end?: unknown;
  endText?: unknown;
  off?: unknown;
}): BranchWords {
  return {
    label: branch.label,
    ends: branch.end === "end" ? String(branch.endText) : null,
    off: typeof branch.off === "string" ? branch.off : null,
  };
}

// ---- the compiler's side ----------------------------------------------------------------------------------------

/**
 * The compiler's words for one path: every step `path` lights in the applied flow (T-136 walkPath), its words picked
 * for the path, each message's plain text (T-134 plainText), and the branches lit on it. `applied` is applyTrade() of
 * the path's trade and flow (T-135), before Master Corrections; T-162 may hand in the same flow corrected.
 */
export function compilerWords(applied: AppliedTrade, path: TradePath, options: WordsOptions = {}): PathWords {
  if (applied.flow.id !== path.flow)
    throw new Error(
      `${applied.trade}: the applied flow is flow ${applied.flow.id}, the path is flow ${path.flow}'s`,
    );
  const walk = walkPath(applied, path, {
    sets: options.sets === true,
    ...(options.stops === "settled" ? {} : { settle: (words: AppliedStep) => words }),
  });
  return {
    trade: applied.trade,
    flow: path.flow,
    path: pathName(path),
    steps: walk.steps.map((at): StepWords => {
      const branches: BranchWords[] = [];
      (at.step.branches ?? []).forEach((branch, k) => {
        const light = at.branches[k];
        const fits =
          light?.lit === true || (branch.off !== undefined && lit(applied, branch.when, at.reading));
        if (fits) branches.push(branchWords(branch));
      });
      return {
        id: at.id,
        reading: pathName(at.reading),
        keys: [...at.keys],
        ...wordsOf(at.words, (message) => plainText(message as Message)),
        branches,
      };
    }),
  };
}

// ---- the reference: the vendored functions on a copy of their own ---------------------------------------------------

/** A path as the vendored functions read it (overlay-core.js lines 6-12), with what fixtures and `sets` add to it. */
export interface RefPath {
  price: string;
  before: string;
  after: string;
  booking?: Record<string, string>;
  pf?: Record<string, boolean>;
  facts?: string[] | null;
  fix?: string;
  base?: string;
  [extra: string]: unknown;
}

interface RefBranch {
  label: string;
  when?: unknown;
  end?: unknown;
  endText?: unknown;
  off?: unknown;
  steps: RefStep[];
}

interface RefStep extends WordsSource {
  id: string;
  when?: unknown;
  off?: unknown;
  branches?: RefBranch[];
  [extra: string]: unknown;
}

interface RefFlow {
  id: FlowLetter;
  steps: RefStep[];
  names?: unknown;
  [extra: string]: unknown;
}

interface RefFixture {
  id: string;
}

/** The parts of the vendored lib.js (and, through it, overlay-core.js and msgtext.js) the reference calls. */
interface RefLib {
  CORE: {
    apply(master: unknown, overlay: unknown, flow: FlowLetter): { flow: RefFlow; errors: string[] };
    syncWays(flow: RefFlow): void;
    switchesOf(overlay: unknown, flow: FlowLetter): Record<string, boolean>;
    factsOf(overlay: unknown): string[] | null;
    bookingOf(overlay: unknown, flow: FlowLetter, applied: RefFlow): Record<string, string[]>;
    lit(when: unknown, path: RefPath): boolean;
    resolveVary(step: RefStep, path: RefPath): { step: RefStep; keys: string[] };
    firstTexts(
      steps: RefStep[],
      path: RefPath,
      opts: { names: unknown },
    ): Record<string, Record<number, unknown>>;
    applyStops(step: RefStep, rec: Record<number, unknown> | undefined): RefStep;
    record(flow: FlowLetter): { fixtures?: RefFixture[] } | null;
    BOOKING: Record<string, { values: [string, string][] }>;
  };
  MSG: { smsText(message: unknown[]): string };
  pathsFor(
    cs: RefPath[],
    steps: RefStep[],
    allowed: Record<string, string[]>,
    fixed: boolean,
    opts: { mix: boolean; fl: FlowLetter },
  ): RefPath[];
  fixturePaths(c: RefPath, flow: FlowLetter, fixtures: RefFixture[]): RefPath[];
  parsePath(text: string, flow: FlowLetter): RefPath | { problems: string[] };
  pathName(path: RefPath): string;
  comboKey(path: RefPath): string;
  litSteps(steps: RefStep[], path: RefPath, fn: (step: RefStep, reading?: RefPath) => void): void;
}

const NEEDED_LIB = ["pathsFor", "fixturePaths", "parsePath", "pathName", "comboKey", "litSteps"];
const NEEDED_CORE = [
  "apply",
  "syncWays",
  "switchesOf",
  "factsOf",
  "bookingOf",
  "lit",
  "resolveVary",
  "firstTexts",
  "applyStops",
  "record",
];

/** One trade's flow as the reference applied it, and its paths once made. */
interface RefApplied {
  overlay: Obj;
  flow: RefFlow;
  paths: RefPath[] | null;
}

/** How many applied flows a Reference keeps (each is a whole flow: T-162 walks 243 trades one after another). */
const KEPT = 4;

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}

/** The steps a trade shows: not switched off by an `off` op, their branches likewise (check-prof's live()). */
function live(steps: readonly RefStep[]): RefStep[] {
  return steps
    .filter((step) => !step.off)
    .map((step) =>
      step.branches === undefined
        ? step
        : {
            ...step,
            branches: step.branches
              .filter((branch) => !branch.off)
              .map((branch) => ({ ...branch, steps: live(branch.steps) })),
          },
    );
}

/** JSON with every object's keys sorted, so two values compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Obj).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A path in one canonical form, for telling whether two paths read alike: the switches that are on (none: no `pf`), the
 * facts list (none: no `facts`, as overlay-core.js reads a missing list), the booking (empty: none); every other field as
 * it is.
 */
function canonicalPath(path: RefPath): string {
  const copy: Obj = { ...path };
  const on = Object.keys(path.pf ?? {})
    .filter((name) => path.pf?.[name] === true)
    .sort();
  if (on.length === 0) delete copy.pf;
  else copy.pf = Object.fromEntries(on.map((name) => [name, true]));
  if (path.facts === null || path.facts === undefined) delete copy.facts;
  if (path.booking !== undefined && Object.keys(path.booking).length === 0) delete copy.booking;
  return canonical(copy);
}

/**
 * The reference: lib.js, overlay-core.js and msgtext.js of fixture set v1 (or of `engine`, another copy of the master's
 * engine folder), loaded on a loader of their own, run on the master's and the trades' files as they are. A Reference
 * keeps its own module state (the money ways, the D75 mark and the record overlay-core.js reads), so each call first
 * makes it read the trade's flow it is about.
 */
export class Reference {
  readonly engine: string;
  private readonly lib: RefLib;
  private readonly applied = new Map<string, RefApplied>();

  constructor(engine: string = FIXTURE_ENGINE) {
    this.engine = engine;
    const lib = makeCjsLoader()(join(engine, "work", "build", "lib.js")) as Partial<RefLib> | null;
    const core = (lib?.CORE ?? {}) as Obj;
    for (const name of NEEDED_LIB)
      if (typeof (lib as Obj | null)?.[name] !== "function")
        throw new Error(`lib.js does not export ${name}()`);
    for (const name of NEEDED_CORE)
      if (typeof core[name] !== "function") throw new Error(`overlay-core.js does not export ${name}()`);
    if (typeof lib?.MSG?.smsText !== "function") throw new Error("msgtext.js does not export smsText()");
    this.lib = lib as RefLib;
  }

  /** The trade's flow as step.js --prof makes it: CORE.apply() on master-<flow>.json and prof/<trade>.json, as they are. */
  private flowOf(trade: string, flow: FlowLetter): RefApplied {
    const key = `${trade} ${flow}`;
    const hit = this.applied.get(key);
    if (hit !== undefined) {
      this.applied.delete(key);
      this.applied.set(key, hit);
      this.lib.CORE.syncWays(hit.flow);
      return hit;
    }
    const master = readJson(join(this.engine, "work", "master", `master-${flow}.json`));
    const overlay = readJson(join(this.engine, "work", "prof", `${trade}.json`));
    const result = this.lib.CORE.apply(master, overlay, flow);
    if (result.errors.length > 0)
      throw new Error(
        `${trade} flow ${flow}: overlay-core.js apply() complained: ${result.errors.join("; ")}`,
      );
    const made: RefApplied = { overlay, flow: result.flow, paths: null };
    this.applied.set(key, made);
    while (this.applied.size > KEPT) {
      const oldest = this.applied.keys().next().value;
      if (oldest === undefined) break;
      this.applied.delete(oldest);
    }
    this.lib.CORE.syncWays(made.flow);
    return made;
  }

  /**
   * The trade's paths in one flow: lib.js pathsFor() over each money path it lists, with its own switches and facts
   * fixed, each booking value it uses laid on alone, and the record's fixtures that ride each money path (the paths
   * T-136's tradePaths makes, private-call aside).
   */
  paths(trade: string, flow: FlowLetter): RefPath[] {
    const entry = this.flowOf(trade, flow);
    if (entry.paths !== null) return entry.paths;
    const { CORE } = this.lib;
    const money = (entry.overlay.money as Record<string, { combos?: unknown }> | undefined)?.[flow];
    const combos = list(money?.combos).map(String);
    const pf = CORE.switchesOf(entry.overlay, flow);
    const facts = CORE.factsOf(entry.overlay);
    const allowed = CORE.bookingOf(entry.overlay, flow, entry.flow);
    const cs = combos.map((combo): RefPath => {
      const [price = "", before = "", after = ""] = combo.split("|");
      return { price, before, after, pf: { ...pf }, facts: facts === null ? null : [...facts] };
    });
    entry.paths = this.lib.pathsFor(cs, live(entry.flow.steps), allowed, true, { mix: false, fl: flow });
    return entry.paths;
  }

  /**
   * The reference's path for a path of the compiler's: the one of paths() with the same name (lib.js pathName). A
   * fixture path the walk leaves out (pathsFor drops private-call: its `privacy: private` is a value only a branch's
   * `sets` reaches, T-136) is made as parsePath reads `<money path> +<fixture>`: fixturePaths() on the same money path.
   * Null when the reference has no such path.
   */
  pathFor(trade: string, flow: FlowLetter, path: TradePath): RefPath | null {
    const name = pathName(path);
    const paths = this.paths(trade, flow);
    const found = paths.find((candidate) => this.lib.pathName(candidate) === name);
    if (found !== undefined) return found;
    const base = typeof path.engine?.base === "string" ? path.engine.base : null;
    if (path.fixture === undefined || base === null) return null;
    const money = paths.find(
      (candidate) => candidate.fix === undefined && this.lib.comboKey(candidate) === base,
    );
    const fixture = this.lib.CORE.record(flow)?.fixtures?.find((candidate) => candidate.id === path.fixture);
    if (money === undefined || fixture === undefined) return null;
    const made = this.lib.fixturePaths(money, flow, [fixture])[0];
    return made !== undefined && this.lib.pathName(made) === name ? made : null;
  }

  /** A reference path's name (lib.js pathName). */
  nameOf(trade: string, flow: FlowLetter, path: RefPath): string {
    this.flowOf(trade, flow);
    return this.lib.pathName(path);
  }

  /** The reference's words for one path: every step it lights, read with the vendored functions, as step.js prints it. */
  words(trade: string, flow: FlowLetter, path: RefPath, options: WordsOptions = {}): PathWords {
    const entry = this.flowOf(trade, flow);
    const { CORE, MSG } = this.lib;
    const stops =
      options.stops === "settled"
        ? CORE.firstTexts(entry.flow.steps, path, { names: entry.flow.names })
        : null;
    const steps: StepWords[] = [];
    const visit = (step: RefStep, reading: RefPath): void => {
      const varied = CORE.resolveVary(step, reading);
      const words = stops === null ? varied.step : CORE.applyStops(varied.step, stops[step.id]);
      steps.push({
        id: step.id,
        reading: this.lib.pathName(reading),
        keys: [...varied.keys],
        ...wordsOf(words, (message) => MSG.smsText(message)),
        branches: (step.branches ?? []).filter((branch) => CORE.lit(branch.when, reading)).map(branchWords),
      });
    };
    if (options.sets === true) {
      this.lib.litSteps(entry.flow.steps, path, (step, reading) => {
        visit(step, reading ?? path);
      });
    } else {
      // lib.js litSteps' walk without `sets` (its lines for a flow with no sets scope): a step that is off or whose
      // `when` does not fit is skipped with its branches; a branch that is lit and not off is followed.
      const go = (level: readonly RefStep[]): void => {
        for (const step of level) {
          if (step.off || (step.when && !CORE.lit(step.when, path))) continue;
          visit(step, path);
          for (const branch of step.branches ?? [])
            if (!branch.off && CORE.lit(branch.when, path)) go(branch.steps);
        }
      };
      go(entry.flow.steps);
    }
    return { trade, flow, path: this.lib.pathName(path), steps };
  }

  /**
   * The path written as step.js --path reads it (lib.js parsePath: `<money path> [+<fixture>] [booking=g:v,...]
   * [pf=s1,s2] [facts=f1,f2]`), with the trade's switches in pf= and its facts in facts=. It is given only where
   * parsePath reads the text back as this very path; else the reason it cannot be said that way (a header-only fact
   * that facts= refuses, for one).
   */
  stepJsPath(trade: string, flow: FlowLetter, path: RefPath): { text: string } | { reason: string } {
    this.flowOf(trade, flow);
    const { CORE } = this.lib;
    const fixture = path.fix;
    const base =
      fixture === undefined
        ? path
        : this.paths(trade, flow).find(
            (candidate) => candidate.fix === undefined && this.lib.comboKey(candidate) === path.base,
          );
    if (base === undefined)
      return { reason: `no money path ${String(path.base)} for the fixture ${String(fixture)}` };
    const parts = [fixture === undefined ? this.lib.comboKey(path) : `${String(path.base)} +${fixture}`];
    const booking = Object.keys(CORE.BOOKING).flatMap((group) => {
      const value = base.booking?.[group];
      const first = CORE.BOOKING[group]?.values[0]?.[0];
      return value === undefined || value === first ? [] : [`${group}:${value}`];
    });
    if (booking.length > 0) parts.push(`booking=${booking.join(",")}`);
    const on = Object.keys(path.pf ?? {}).filter((name) => path.pf?.[name] === true);
    if (on.length > 0) parts.push(`pf=${on.join(",")}`);
    if (Array.isArray(path.facts)) parts.push(`facts=${path.facts.join(",")}`);
    const text = parts.join(" ");
    const parsed = this.lib.parsePath(text, flow);
    const problems = (parsed as { problems?: unknown }).problems;
    if (Array.isArray(problems))
      return { reason: `step.js --path refuses "${text}": ${problems.map(String).join("; ")}` };
    const read = parsed as RefPath;
    if (canonicalPath(read) !== canonicalPath(path))
      return { reason: `step.js --path reads "${text}" as another path (${this.lib.pathName(read)})` };
    return { text };
  }
}

// ---- comparing ------------------------------------------------------------------------------------------------------

function branchLine(branch: BranchWords): string {
  return `${branch.label}${branch.ends === null ? "" : ` → ends: ${branch.ends}`}${branch.off === null ? "" : ` [off: ${branch.off}]`}`;
}

/** Each step's key in a walk: its id and reading, numbered where the same step is read twice with the same reading. */
function stepKeys(words: PathWords): string[] {
  const seen = new Map<string, number>();
  return words.steps.map((step) => {
    const key = `${step.id} on ${step.reading}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key} (${String(n + 1)})`;
  });
}

/**
 * Every difference between the compiler's words for a path and the reference's: a step lit on one side only, the steps
 * in another order, and, for each step both light, each field that differs (each line, message, row or branch of a list
 * field by its index).
 */
export function compareWords(got: PathWords, want: PathWords): WordDifference[] {
  const at = { trade: want.trade, flow: want.flow, path: want.path, side: "compiler" as const };
  const out: WordDifference[] = [];
  if (got.trade !== want.trade || got.flow !== want.flow)
    throw new Error(`compareWords: ${got.trade} flow ${got.flow} against ${want.trade} flow ${want.flow}`);
  if (got.path !== want.path)
    out.push({ ...at, step: "", field: "path", index: null, got: got.path, want: want.path });

  const gotKeys = stepKeys(got);
  const wantKeys = stepKeys(want);
  const gotAt = new Map(gotKeys.map((key, k) => [key, k]));
  const wantAt = new Map(wantKeys.map((key, k) => [key, k]));
  wantKeys.forEach((key, k) => {
    if (!gotAt.has(key))
      out.push({ ...at, step: want.steps[k]?.id ?? "", field: "step", index: k, got: null, want: key });
  });
  gotKeys.forEach((key, k) => {
    if (!wantAt.has(key))
      out.push({ ...at, step: got.steps[k]?.id ?? "", field: "step", index: k, got: key, want: null });
  });
  const commonGot = gotKeys.filter((key) => wantAt.has(key));
  const commonWant = wantKeys.filter((key) => gotAt.has(key));
  const moved = commonWant.findIndex((key, k) => commonGot[k] !== key);
  if (moved >= 0) {
    const key = commonWant[moved] ?? "";
    out.push({
      ...at,
      step: want.steps[wantAt.get(key) ?? -1]?.id ?? "",
      field: "step",
      index: moved,
      got: `${commonGot[moved] ?? ""} (out of order from here)`,
      want: key,
    });
  }

  for (const key of commonWant) {
    const mine = got.steps[gotAt.get(key) ?? -1];
    const theirs = want.steps[wantAt.get(key) ?? -1];
    if (mine === undefined || theirs === undefined) continue;
    const step = theirs.id;
    const one = (field: WordField, a: string | null, b: string | null): void => {
      if (a !== b) out.push({ ...at, step, field, index: null, got: a, want: b });
    };
    const many = (field: WordField, a: readonly string[], b: readonly string[]): void => {
      for (let k = 0; k < Math.max(a.length, b.length); k += 1) {
        if (a[k] !== b[k]) out.push({ ...at, step, field, index: k, got: a[k] ?? null, want: b[k] ?? null });
      }
    };
    one("keys", mine.keys.join(", "), theirs.keys.join(", "));
    one("does", mine.does, theirs.does);
    many("more", mine.more, theirs.more);
    many("say", mine.say, theirs.say);
    many("form", mine.form, theirs.form);
    one("rule", mine.rule, theirs.rule);
    many("branches", mine.branches.map(branchLine), theirs.branches.map(branchLine));
  }
  return out;
}

/** One difference as a line of a report: trade, flow, path, step, field, and both sides' words. */
export function formatDifference(difference: WordDifference): string {
  const where = `${difference.trade} flow ${difference.flow} "${difference.path}"`;
  const field = `${difference.field}${difference.index === null ? "" : `[${String(difference.index)}]`}`;
  return `${where} ${difference.step === "" ? "" : `${difference.step} `}${field}: ${difference.side} ${JSON.stringify(difference.got)}, the reference ${JSON.stringify(difference.want)}`;
}

/** The compiler's words for a path beside the reference's, and their differences (none: the path is at parity). */
export interface PathParity {
  compiler: PathWords;
  /** Null when the reference has no path of that name. */
  reference: PathWords | null;
  /** The reference's path, which stepJsPath() can write for step.js. */
  referencePath: RefPath | null;
  differences: WordDifference[];
}

/** Holds the compiler's words for one path of `applied` against the reference's, read the same way (`options`). */
export function comparePath(
  reference: Reference,
  applied: AppliedTrade,
  path: TradePath,
  options: WordsOptions = {},
): PathParity {
  const compiler = compilerWords(applied, path, options);
  const flow = applied.flow.id;
  const referencePath = reference.pathFor(applied.trade, flow, path);
  if (referencePath === null) {
    return {
      compiler,
      reference: null,
      referencePath,
      differences: [
        {
          trade: applied.trade,
          flow,
          path: compiler.path,
          step: "",
          field: "path",
          index: null,
          side: "compiler",
          got: compiler.path,
          want: null,
        },
      ],
    };
  }
  const want = reference.words(applied.trade, flow, referencePath, options);
  return { compiler, reference: want, referencePath, differences: compareWords(compiler, want) };
}

// ---- step.js ----------------------------------------------------------------------------------------------------------

/** One printed line of a step's `- on` block, with the field and index it shows. */
export interface StepJsLine {
  field: WordField;
  index: number | null;
  line: string;
}

/** A step's words as step.js prints them under its `- on <path>` line (step.js lines 81-86), one line each. */
export function stepJsLines(step: StepWords): StepJsLine[] {
  const out: StepJsLine[] = [];
  const add = (field: WordField, index: number | null, line: string): void => {
    for (const printed of line.split("\n")) out.push({ field, index, line: printed });
  };
  if (step.does !== null) add("does", null, `  ${step.does}`);
  step.more.forEach((line, k) => {
    add("more", k, `    - ${line}`);
  });
  step.say.forEach((message, k) => {
    add("say", k, `      ${message.replace(/\n/g, " / ")}`);
  });
  step.form.forEach((row, k) => {
    add("form", k, `    [screen] ${row}`);
  });
  if (step.rule !== null) add("rule", null, `  RULE: ${step.rule}`);
  step.branches.forEach((branch, k) => {
    add("branches", k, `    > ${branch.label}${branch.ends === null ? "" : ` → ends: ${branch.ends}`}`);
  });
  return out;
}

/** The head of a step's `- on` block as step.js prints it (step.js line 80), up to its record summary. */
export function stepJsHead(step: StepWords): string {
  return `- on ${step.reading} [keys: ${step.keys.join(", ") || "base"}]`;
}

/** Each step's lines in step.js's printout, by id: from its `### <id> · ` line up to the next step's (the first block of an id). */
export function stepJsBlocks(output: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split("\n")) {
    const head = /^### (\S+) · /.exec(line);
    if (head?.[1] !== undefined) {
      current = out.has(head[1]) ? null : [];
      if (current !== null) out.set(head[1], current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

/**
 * Every difference between the reference's words for a path and step.js's printout for the same path (`output`: step.js
 * run with each of the path's step ids, --prof and --path): a step it did not print, the head of its `- on` block (the
 * path's name and the keys; the record summary after them is not a word field and is not compared), and each line under
 * it. Only a walk read step.js's way (no `sets`, the marker as written) can equal it.
 */
export function compareStepJs(want: PathWords, output: string): WordDifference[] {
  const at = { trade: want.trade, flow: want.flow, path: want.path, side: "step.js" as const };
  const blocks = stepJsBlocks(output);
  const out: WordDifference[] = [];
  for (const step of want.steps) {
    const lines = blocks.get(step.id);
    const head = stepJsHead(step);
    const start = lines?.findIndex((line) => line === head || line.startsWith(`${head} · `)) ?? -1;
    if (lines === undefined || start < 0) {
      const printed = lines?.find((line) => line.startsWith("- on ")) ?? null;
      out.push({
        ...at,
        step: step.id,
        field: lines === undefined ? "step" : "keys",
        index: null,
        got: printed,
        want: head,
      });
      continue;
    }
    const printed = lines.slice(start + 1);
    while (printed.length > 0 && printed[printed.length - 1] === "") printed.pop();
    const expected = stepJsLines(step);
    for (let k = 0; k < Math.max(printed.length, expected.length); k += 1) {
      const line = expected[k];
      if (line?.line === printed[k]) continue;
      out.push({
        ...at,
        step: step.id,
        field: line?.field ?? fieldOfPrinted(printed[k] ?? ""),
        index: line?.index ?? null,
        got: printed[k] ?? null,
        want: line?.line ?? null,
      });
    }
  }
  return out;
}

/** Which field a line of step.js's `- on` block prints, read from its start (only for a line the reference lacks). */
function fieldOfPrinted(line: string): WordField {
  if (line.startsWith("  RULE: ")) return "rule";
  if (line.startsWith("    [screen] ")) return "form";
  if (line.startsWith("    > ")) return "branches";
  if (line.startsWith("      ")) return "say";
  if (line.startsWith("    - ")) return "more";
  return "does";
}

/**
 * Runs the master copy's step.js (`node <stepJs> <flow> <ids...> --prof <trade> --path <text>`) and gives its printout.
 * step.js finds the master's files from its own folder (lib.js HERE), so it runs from any working folder.
 */
export function runStepJs(
  stepJs: string,
  trade: string,
  flow: FlowLetter,
  ids: readonly string[],
  pathText: string,
): string {
  return execFileSync(process.execPath, [stepJs, flow, ...ids, "--prof", trade, "--path", pathText], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
}

/**
 * The folders where a master copy's engine/ may be (rule 2's scratch copy, git-ignored): this checkout's
 * scratch/master-copy/engine and, when this checkout is a linked git worktree, its main checkout's.
 */
export function masterCopyCandidates(root: string = REPO_ROOT): string[] {
  const out = [join(root, "scratch", "master-copy", "engine")];
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return out;
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
  if (gitdir === undefined) return out;
  const own = resolve(root, gitdir);
  const commondir = join(own, "commondir");
  if (!existsSync(commondir)) return out;
  const common = resolve(own, readFileSync(commondir, "utf8").trim());
  out.push(join(dirname(common), "scratch", "master-copy", "engine"));
  return out;
}

/** The master copy's engine folder and its step.js, or why there is none (CI has no master copy). */
export function findMasterCopy(
  root: string = REPO_ROOT,
): { engine: string; stepJs: string } | { reason: string } {
  const tried = masterCopyCandidates(root);
  for (const engine of tried) {
    const stepJs = join(engine, "work", "build", "step.js");
    if (existsSync(stepJs)) return { engine, stepJs };
  }
  return {
    reason: `no master copy holds work/build/step.js (looked in ${tried.join(" and ")}); scratch/ is git-ignored, so CI has none`,
  };
}

/**
 * The inputs step.js reads that differ, byte for byte, between a master copy's engine folder and fixture set v1's: the
 * three scripts, both flows, LINES.md and the trade files named. Empty when step.js reads what the reference reads.
 */
export function masterCopyDiffers(engine: string, trades: readonly string[]): string[] {
  const files = [
    "work/build/lib.js",
    "work/build/overlay-core.js",
    "work/build/msgtext.js",
    "work/master/master-A.json",
    "work/master/master-B.json",
    "design/LINES.md",
    ...trades.map((trade) => `work/prof/${trade}.json`),
  ];
  return files.filter((file) => {
    const copy = join(engine, file);
    const fixture = join(FIXTURE_ENGINE, file);
    return !existsSync(copy) || !existsSync(fixture) || !readFileSync(copy).equals(readFileSync(fixture));
  });
}
