// L6, a name the cut list removed (T-154; lib.js lintSteps lines 1923-1924; liveSet, cutWhat and cutHits, lines
// 1980-2007; TOOL-SPEC 8:20pm #6, #13).
//
// The record's `live` block holds the cut list (CUT-LIST): the switches and facts still live, the booking values cut
// (`off`: reach notsafe, times noperson and line, approval expert) and the old names merged into live ones (`merged`:
// the switch grief is now sensitive, the fact memberships is now packs ...). A step anywhere in the flow that still
// names a cut one is an error: take it out, or, for a merged name, use what replaced it. L6 reads:
//   - each vary key: its switches (`pf:grief`) and its booking values (`booking:notsafe`);
//   - the step's own `when`, and each branch's `when` (and `whenIn`): its switches (switchOn, switchOff), its facts (pf,
//     factOn, factOff) and its booking values;
//   - each branch's `sets`: a value of the group it names (`svcAdd`, a service, aside).
// One hit a field and name. A switch or fact is cut when the record lists the live ones and it is not among them; a
// booking value is cut when `off` lists it under its group: the group a `sets` names, else the value's own group in
// the vendored overlay-core.js (GROUP_OF, with the record's own groups charge, contact and payer, as for L1).
//
// The loaders let only text into these lists (a `when` list, a `sets` value): that is all L6 reads.
import { loadPathScripts } from "../path/core";
import type { CompiledRecord } from "../record";
import { isRecord, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** The record's live block, as L6 reads it (lib.js liveSet). */
export interface LiveSet {
  /** The live switches, or null when the record does not list them (then none is cut). */
  readonly switches: ReadonlySet<unknown> | null;
  /** The live facts, or null when the record does not list them. */
  readonly facts: ReadonlySet<unknown> | null;
  /** The cut booking values, by group. */
  readonly off: Readonly<Record<string, unknown>>;
  /** The merged names: `switches` and `facts`, each old name to what replaced it. */
  readonly merged: Readonly<Record<string, unknown>>;
}

/** The record's live block, or null when it has none: then L6 reads nothing (lib.js liveSet). */
export function liveSet(record: CompiledRecord): LiveSet | null {
  const live: unknown = record.live;
  if (!isRecord(live)) return null;
  return {
    switches: Array.isArray(live.switches) ? new Set(live.switches as unknown[]) : null,
    facts: Array.isArray(live.facts) ? new Set(live.facts as unknown[]) : null,
    off: isRecord(live.off) ? live.off : {},
    merged: isRecord(live.merged) ? live.merged : {},
  };
}

/** The vendored tables L6 reads: overlay-core.js parseVaryKey(), GROUP_OF and EVENT_GROUPS. */
interface CutCore {
  parseVaryKey(key: string): Readonly<Record<string, readonly string[] | undefined>> | null;
  GROUP_OF: Record<string, string>;
  EVENT_GROUPS?: unknown;
}

function core(): CutCore {
  return loadPathScripts().core as unknown as CutCore;
}

let groups: ReadonlyMap<string, string> | null = null;

/**
 * The booking group of a value, the record's own groups included: overlay-core.js GROUP_OF, and EVENT_GROUPS (charge,
 * contact, payer), which GROUP_OF holds only while a record is loaded, as it is when lib.js lints. Read once.
 */
function groupOf(value: string): string | undefined {
  if (groups === null) {
    const tables = core();
    if (!isRecord(tables.EVENT_GROUPS))
      throw new Error("overlay-core.js does not export EVENT_GROUPS (the record's booking groups)");
    const made = new Map<string, string>();
    for (const [group, entry] of Object.entries(tables.EVENT_GROUPS)) {
      const values = isRecord(entry) && Array.isArray(entry.values) ? (entry.values as unknown[]) : [];
      for (const pair of values)
        if (Array.isArray(pair) && typeof pair[0] === "string") made.set(pair[0], group);
    }
    for (const [name, group] of Object.entries(tables.GROUP_OF)) made.set(name, group);
    groups = made;
  }
  return groups.get(value);
}

type Kind = "switch" | "fact" | "value";

/** What is cut about one name, as L6 words it ("switch grief (now: sensitive ...)", "reach notsafe"), or null (lib.js cutWhat). */
export function cutWhat(live: LiveSet, kind: Kind, name: string, group?: string): string | null {
  if (kind !== "value") {
    const set = kind === "switch" ? live.switches : live.facts;
    if (set === null || set.has(name)) return null;
    const table = live.merged[kind === "switch" ? "switches" : "facts"];
    const now = isRecord(table) ? table[name] : undefined;
    return `${kind} ${name}${typeof now === "string" && now !== "" ? ` (now: ${now})` : ""}`;
  }
  const own = group !== undefined && group !== "" ? group : groupOf(name);
  if (own === undefined) return null;
  const cut = live.off[own];
  return Array.isArray(cut) && (cut as unknown[]).includes(name) ? `${own} ${name}` : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
}

/** Each field of a step that names something cut, with what: [field, what], each pair once (lib.js cutHits). */
export function cutHits(step: LintStep, live: LiveSet): [field: string, what: string][] {
  const out: [string, string][] = [];
  const add = (field: string, what: string | null): void => {
    if (what !== null && !out.some(([f, w]) => f === field && w === what)) out.push([field, what]);
  };
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const key of Object.keys(vary)) {
    const parts = core().parseVaryKey(key) ?? {};
    for (const name of parts.pf ?? []) add(`vary '${key}'`, cutWhat(live, "switch", name));
    for (const value of parts.booking ?? []) add(`vary '${key}'`, cutWhat(live, "value", value));
  }
  const gate = (field: string, when: unknown): void => {
    if (!isRecord(when)) return;
    for (const [key, list] of Object.entries(when)) {
      if (key === "switchOn" || key === "switchOff")
        for (const name of strings(list)) add(`${field} ${key}`, cutWhat(live, "switch", name));
      else if (key === "pf" || key === "factOn" || key === "factOff")
        for (const name of strings(list)) add(`${field} ${key}`, cutWhat(live, "fact", name));
      else if (key === "booking")
        for (const value of strings(list)) add(`${field} booking`, cutWhat(live, "value", value));
    }
  };
  gate("when", step.when);
  for (const branch of step.branches ?? []) {
    const at = `branch '${branch.label}'`;
    gate(`${at} when`, branch.when);
    // (a shared part's per-flow `when`: the join resolves it, so a joined flow has none)
    const whenIn = "whenIn" in branch ? branch.whenIn : undefined;
    if (isRecord(whenIn))
      for (const [flow, when] of Object.entries(whenIn)) gate(`${at} whenIn.${flow}`, when);
    if (!isRecord(branch.sets)) continue;
    for (const [group, value] of Object.entries(branch.sets))
      if (group !== "svcAdd" && typeof value === "string")
        add(`${at} sets`, cutWhat(live, "value", value, group));
  }
  return out;
}

/** L6: a name the cut list removed. */
export const l6: LintRule = {
  id: "L6",
  name: "cut",
  source: "lib.js lintSteps lines 1923-1924, liveSet, cutWhat and cutHits lines 1980-2007; record.live",
  run(ctx: LintContext): LintHit[] {
    const live = liveSet(ctx.record);
    if (live === null) return [];
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      for (const [field, what] of cutHits(step, live))
        hits.push({
          rule: "L6",
          level: "error",
          step: step.id,
          field,
          text: what,
          fix: `cut by CUT-LIST: ${what}: take it out${what.includes("(now: ") ? ", or use what replaced it" : ""}`,
        });
    }
    return hits;
  },
};
