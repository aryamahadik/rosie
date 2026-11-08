// 02-contracts section 11, the walking skeleton's hops and their contracts (D-017), as the hop-prefix mode reads it
// (T-551; C-148). Each row: its hop in section 11's words; the name its join task runs it under (`SKELETON_UPTO=<name>`,
// T-552 to T-563; "gateway" is also D-017's own name for the first hop); its last K-08 hop; and the contracts whose tests
// pass before it joins (section 11's third column; build prompt section 10, D-017: "Each hop's contract test is green
// before the next joins").
//
// A row's K-08 hops are never listed here: they are T-465's SKELETON_HOPS (section 11's rows as K-08 hop names, T-465
// default 1), cut at each row's last hop. Section 11's last row, "All under one trace id" (every hop; K-08), is no hop:
// it is the trace-wide check T-465's checkHops makes on every span (one trace id, one bundle id, seq, time).
//
// Each contract's test file is the one its README names ("**Contract test:** `tests/contract/<name>.v1.test.ts`"), read
// from contracts/ when first asked for, at v1: the walking skeleton reads K-01 to K-09 v1 and K-11 (02-contracts
// section 10).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACTS_ROOT } from "../../../contract/_harness";
import { SKELETON_HOPS } from "../index";

/** One of the walking skeleton's hops, by K-08 v1's name (T-465's SKELETON_HOPS). */
export type SkeletonHop = (typeof SKELETON_HOPS)[number];

/** A contract by its plan id (02-contracts section 3), such as "K-11". */
export type ContractId = `K-${string}`;

interface RowSource {
  /** The hop in section 11's words (its first column). */
  readonly words: string;
  /** The name the row's join task gives it in `SKELETON_UPTO=<name>`, or null when it has none. */
  readonly join: string | null;
  /** The row's last K-08 hop: the row holds SKELETON_HOPS after the row before it, up to and including this one. */
  readonly through: SkeletonHop;
  /** Section 11's "Contract (and its test)" column. */
  readonly contracts: readonly ContractId[];
}

/** Section 11's hop rows, in D-017's turn order. */
const ROWS = [
  { words: "Webhook in, signature checked", join: "gateway", through: "receive", contracts: ["K-11"] },
  { words: "Sealed event", join: "actor-inbox", through: "scrub", contracts: ["K-06"] },
  {
    words: "Safety read on each raw text, on arrival, before batching",
    join: "safety-read",
    through: "safetyRead",
    contracts: ["K-02"],
  },
  { words: "Batch and turn lease", join: "lease", through: "lease", contracts: ["K-04", "K-06"] },
  { words: "Guard: keywords, then targets", join: "guard", through: "guard", contracts: ["K-01", "K-04"] },
  {
    words: "Frontier from the Tool API",
    join: "frontier",
    through: "frontier",
    contracts: ["K-09", "K-02", "K-01"],
  },
  { words: "Decide, two reads", join: "decide", through: "decideReads", contracts: ["K-02"] },
  {
    words:
      "Gate and one commit: state, the open question and its clock row, one outbox row, the event log, under the turn id",
    join: "commit",
    through: "commit",
    contracts: ["K-09", "K-05", "K-04", "K-07", "K-08"],
  },
  {
    words: "The composer returns that row's plan",
    join: "compose",
    through: "compose",
    contracts: ["K-09", "K-03"],
  },
  {
    words: "Code fills slots and fixed lines; claim check and message checks",
    join: "finalize",
    through: "fillAndChecks",
    contracts: ["K-09", "K-03"],
  },
  { words: "Outbox dispatcher, limit 8", join: "dispatch", through: "dispatch", contracts: ["K-05", "K-07"] },
  { words: "Send to the Linq double", join: "send", through: "providerAccepted", contracts: ["K-11"] },
  // T-564 joins this row and runs the full check, with no prefix: the row has no join name.
  {
    words: "Delivery receipt; the clock arms",
    join: null,
    through: "clockArmed",
    contracts: ["K-06", "K-05"],
  },
] as const satisfies readonly RowSource[];

/** One hop row of 02-contracts section 11. */
export interface Section11Row {
  /** Its place in section 11, from 1. */
  readonly row: number;
  readonly words: string;
  readonly join: string | null;
  /** Its K-08 hops, in turn order: a run of SKELETON_HOPS. */
  readonly hops: readonly SkeletonHop[];
  readonly contracts: readonly ContractId[];
}

function rowsOf(sources: readonly RowSource[]): readonly Section11Row[] {
  let from = 0;
  return sources.map((source, index) => {
    const to = SKELETON_HOPS.indexOf(source.through) + 1;
    if (to <= from) {
      throw new Error(
        `02-contracts section 11 row ${String(index + 1)} ends at hop ${source.through}, which is not after the row before`,
      );
    }
    const hops = SKELETON_HOPS.slice(from, to);
    from = to;
    return { row: index + 1, words: source.words, join: source.join, hops, contracts: source.contracts };
  });
}

/** 02-contracts section 11's hop rows, in turn order, each with its K-08 hops cut from SKELETON_HOPS. */
export const SECTION_11_ROWS: readonly Section11Row[] = rowsOf(ROWS);

/** The section 11 row a skeleton hop belongs to. */
export function rowOfHop(hop: SkeletonHop): Section11Row {
  const row = SECTION_11_ROWS.find((candidate) => candidate.hops.includes(hop));
  if (row === undefined) throw new Error(`hop ${hop} is in no row of 02-contracts section 11`);
  return row;
}

/** A contract's v1 test file, as the contract's README names it. */
export interface ContractTest {
  readonly contract: ContractId;
  /** The contract's folder under contracts/, as its README's heading names it ("port-linq", "db-schema/core"). */
  readonly name: string;
  /** The test file, from the repository root: "tests/contract/<name>.v1.test.ts". */
  readonly file: string;
}

/** A contract README's first line: "# <folder> (K-xx): ...". */
const HEADING = /^# (\S+) \((K-[0-9]{2})\)/;
/** Where a contract README names its v1 contract test. */
const V1_TEST = /\*\*Contract test:\*\* `(tests\/contract\/[A-Za-z0-9.-]+\.v1\.test\.ts)`/;
/** Folders under contracts/ that hold no contract README. */
const SKIPPED = new Set(["node_modules", "generated", "scripts", "fixtures", "vendor-samples"]);

let readmes: ReadonlyMap<string, readonly ContractTest[]> | undefined;

/** Every contract README under contracts/ (a contract's folder, or a database part's), by the contract it names. */
function contractReadmes(): ReadonlyMap<string, readonly ContractTest[]> {
  if (readmes !== undefined) return readmes;
  const found = new Map<string, ContractTest[]>();
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const folder = path.join(dir, entry.name);
      const readme = path.join(folder, "README.md");
      if (existsSync(readme)) {
        const text = readFileSync(readme, "utf8");
        const heading = HEADING.exec(text);
        const test = V1_TEST.exec(text);
        if (heading?.[1] !== undefined && heading[2] !== undefined && test?.[1] !== undefined) {
          const contract = heading[2] as ContractId;
          found.set(contract, [
            ...(found.get(contract) ?? []),
            { contract, name: heading[1], file: test[1] },
          ]);
        }
      }
      if (depth < 2) visit(folder, depth + 1);
    }
  };
  visit(CONTRACTS_ROOT, 1);
  readmes = found;
  return found;
}

/** The v1 contract test of `contract`, as its README names it. Throws when no README, or more than one, names it. */
export function contractTestOf(contract: ContractId): ContractTest {
  const named = contractReadmes().get(contract) ?? [];
  const [test] = named;
  if (test === undefined || named.length > 1) {
    throw new Error(
      `${String(named.length)} contract READMEs under contracts/ name ${contract} with a v1 contract test, where one must`,
    );
  }
  return test;
}
