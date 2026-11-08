// Stand-ins for what K-01 v1 requires and another task or role gives (T-149). The emitter packs what it is given; a
// build that is not given one of these takes the stand-in named here, and says so (the build command prints each one).
// None is written here: each is read from a committed file, K-01 v1's own accepted fixtures above all, or is a plain
// placeholder that cannot pass for a real value (an all-zero hash, the epoch).
//
//   bundle id      T-150 gives it (from the hashes of the stored values). Stand-in: hash 64 zeros, build 1.
//   built at       the publish gives it; a build writes no clock time of its own (byte-identical builds). Stand-in: the
//                  epoch, 1970-01-01T00:00:00Z.
//   inputs         T-150 gives every input's hash (Master Corrections, LINES.md, the approved overlays, fixture set
//                  v1's MANIFEST.sha256). Stand-in: the entries of fixtures/master/SHA256SUMS (T-130) for the two flows,
//                  LINES.md, the three reference scripts and the trades the bundle holds.
//   prompts        the AI engineer's (C-119), packed from the files the build is given. Stand-in: the sample prompts
//                  of contracts/bundle/fixtures/manifest.json.
//   models, policy the AI engineer's (C-121). Stand-in: manifest.json's, which are arch 11 line 564's model ids and
//                  Q-26's routing by stakes.
//   judgment rules T-1050 gives the 67 numbered rules. Stand-in: contracts/bundle/fixtures/judgment-rules.json.
//   a shared list  a module's shared-list.ts gives it (shared-lists.ts). Stand-in for a list none gives yet: the list's
//                  own fixture (fixed-lines.json, out-of-scope-c9-first-texts.json, keywords.json, key-map.json).
import { readFileSync } from "node:fs";
import type { TradeId } from "../load/trade";
import type { JudgmentRules } from "./flow";
import type { SharedListName } from "./shared-lists";

type Obj = Record<string, unknown>;

/** The prompts one turn runs on (K-01 manifest.prompts), as the emitter is given them: each one's version and text. */
export const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
export type PromptTexts = Record<PromptKind, { version: string; text: string }>;

/** K-01 manifest.models and manifest.policy. */
export interface ModelRouting {
  models: { haiku: string; sonnet: string };
  policy: {
    low: { first: string; second: string };
    high: { first: string; second: string };
    reread: string;
  };
}

/** One input of the build with its hash (K-01 `inputFile`). */
export interface InputFile {
  kind:
    | "masterFlow"
    | "trade"
    | "masterCorrections"
    | "lines"
    | "approvedOverlay"
    | "fixtureSetManifest"
    | "referenceCode";
  path: string;
  sha256: string;
  trade?: TradeId;
  version?: string;
}

/** A bundle id (K-01 manifest.bundleId; common formats bundleId). */
export interface BundleId {
  hash: string;
  build: number;
}

/** One stand-in a build used: what it stands in for, who gives the real one, and where the stand-in comes from. */
export interface StandIn {
  what: string;
  owner: string;
  from: string;
}

/** The bundle id a build takes when it is given none: 64 zeros, build 1 (T-150 gives the real one). */
export const STANDIN_BUNDLE_ID: Readonly<BundleId> = { hash: "0".repeat(64), build: 1 };

/** The build time a build writes when it is given none: the epoch, so no clock time enters the output. */
export const STANDIN_BUILT_AT = "1970-01-01T00:00:00Z";

const FIXTURES = new URL("../../../contracts/bundle/fixtures/", import.meta.url);
const SHA256SUMS = new URL("../../../fixtures/master/SHA256SUMS", import.meta.url);

/** Where each shared list's stand-in comes from: its K-01 v1 fixture. */
export const STANDIN_LIST_FIXTURES: Readonly<Record<SharedListName, string>> = {
  keywords: "keywords.json",
  fixedLines: "fixed-lines.json",
  keyMap: "key-map.json",
  outOfScope: "out-of-scope-c9-first-texts.json",
};

/** Who gives each shared list for real. */
const LIST_OWNERS: Readonly<Record<SharedListName, string>> = {
  keywords: "T-134 (a module's shared-list.ts)",
  fixedLines: "the fixed lines' task (a module's shared-list.ts; arch 07 line 361, Q-01)",
  keyMap: "T-143 (a module's shared-list.ts)",
  outOfScope: "T-147 and T-148 (compiler/src/scope/shared-list.ts)",
};

function fixture(name: string): Obj {
  const parsed = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`contracts/bundle/fixtures/${name} does not hold an object`);
  return parsed as Obj;
}

/** A stand-in's value, and what it stands in for. */
export interface StandInValue<T> {
  value: T;
  standIn: StandIn;
}

/** The stand-in prompts: the sample prompts of contracts/bundle/fixtures/manifest.json, each its version and text. */
export function standInPrompts(): StandInValue<PromptTexts> {
  const given = fixture("manifest.json").prompts as Record<string, { version: string; text: string }>;
  const prompts = {} as PromptTexts;
  for (const kind of PROMPT_KINDS) {
    const prompt = given[kind];
    if (prompt === undefined) throw new Error(`manifest.json has no ${kind} prompt`);
    prompts[kind] = { version: prompt.version, text: prompt.text };
  }
  return {
    value: prompts,
    standIn: {
      what: "prompts",
      owner: "the AI engineer (C-119): pass --prompts <file>",
      from: "contracts/bundle/fixtures/manifest.json prompts",
    },
  };
}

/** The stand-in model ids and routing by stakes: contracts/bundle/fixtures/manifest.json's (arch 11 line 564; Q-26). */
export function standInModelRouting(): StandInValue<ModelRouting> {
  const manifest = fixture("manifest.json");
  return {
    value: {
      models: structuredClone(manifest.models) as ModelRouting["models"],
      policy: structuredClone(manifest.policy) as ModelRouting["policy"],
    },
    standIn: {
      what: "models and policy",
      owner: "the AI engineer (C-121): pass --models <file>",
      from: "contracts/bundle/fixtures/manifest.json models and policy (arch 11 line 564; Q-26)",
    },
  };
}

/** The stand-in judgment rules: contracts/bundle/fixtures/judgment-rules.json (MC R6, word for word from S13-23 on). */
export function standInJudgmentRules(): StandInValue<JudgmentRules> {
  return {
    value: fixture("judgment-rules.json") as unknown as JudgmentRules,
    standIn: {
      what: "judgment rules",
      owner: "T-1050",
      from: "contracts/bundle/fixtures/judgment-rules.json",
    },
  };
}

/** The stand-in of one shared list no module gives: its K-01 v1 fixture. */
export function standInList(list: SharedListName): StandInValue<unknown> {
  const file = STANDIN_LIST_FIXTURES[list];
  return {
    value: fixture(file),
    standIn: { what: `lists.${list}`, owner: LIST_OWNERS[list], from: `contracts/bundle/fixtures/${file}` },
  };
}

/** The stand-in bundle id (T-150 gives the real one). */
export function standInBundleId(): StandInValue<BundleId> {
  return {
    value: { ...STANDIN_BUNDLE_ID },
    standIn: {
      what: "bundle id",
      owner: "T-150: pass --bundle-id <hash>/<build>",
      from: `hash ${STANDIN_BUNDLE_ID.hash}, build ${String(STANDIN_BUNDLE_ID.build)}`,
    },
  };
}

/** The stand-in build time (the publish gives the real one). */
export function standInBuiltAt(): StandInValue<string> {
  return {
    value: STANDIN_BUILT_AT,
    standIn: {
      what: "built at",
      owner: "the publish (T-152): pass --built-at <utc>",
      from: STANDIN_BUILT_AT,
    },
  };
}

const MASTER_FLOW = /^engine\/work\/master\/master-[AB]\.json$/;
const TRADE_FILE = /^engine\/work\/prof\/([a-z0-9][a-z0-9-]*)\.json$/;
const REFERENCE = /^engine\/work\/build\/[a-z-]+\.js$/;

/**
 * The stand-in inputs: the lines of fixtures/master/SHA256SUMS (T-130, `<sha256>  <path>`) for the two flows,
 * LINES.md, the reference scripts and the trades in `trades`, in the file's order.
 */
export function standInInputs(trades: readonly TradeId[]): StandInValue<InputFile[]> {
  const wanted = new Set(trades);
  const inputs: InputFile[] = [];
  for (const line of readFileSync(SHA256SUMS, "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) continue;
    const [, sha256 = "", path = ""] = match;
    const trade = TRADE_FILE.exec(path)?.[1];
    if (MASTER_FLOW.test(path)) inputs.push({ kind: "masterFlow", path, sha256 });
    else if (path === "engine/design/LINES.md") inputs.push({ kind: "lines", path, sha256 });
    else if (REFERENCE.test(path)) inputs.push({ kind: "referenceCode", path, sha256 });
    else if (trade !== undefined && wanted.has(trade)) inputs.push({ kind: "trade", path, sha256, trade });
  }
  for (const trade of wanted)
    if (!inputs.some((input) => input.trade === trade))
      throw new Error(`fixtures/master/SHA256SUMS has no line for engine/work/prof/${trade}.json`);
  return {
    value: inputs,
    standIn: {
      what: "inputs",
      owner: "T-150 (adds Master Corrections, the approved overlays and fixture set v1's MANIFEST.sha256)",
      from: "fixtures/master/SHA256SUMS",
    },
  };
}
