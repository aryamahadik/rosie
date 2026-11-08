// L5, twin drift (T-154; lib.js mergeShared lines 1704-1713, SHARED_WORDS line 1656).
//
// An A/B twin (A7-06 in flow A, B7-10 in flow B) says its words once, in the shared text both steps name: `text`,
// the flow A step's id ("A7-06"). The master checks this where it joins its six source parts into the two flows
// (build-master.js; lib.js mergeShared). A step that sets a word field its shared text holds, or a branch label or
// endText other than the text's, drifts from its twin, and each is an error:
//   - a word field (title, does, more, say, rule, q, form, table, vary): "the words live in the shared text A7-06: take
//     'does' off the step". A real twin difference is written in the text ({{ab:A words|B words}}) or as addMore lines;
//   - branch N's label ("the shared text A7-06 names it '2 Cancel anyway'") or its endText.
//
// The build reads the two joined flows only (Master Corrections section 1). The source parts and their shared texts
// are not among its inputs, and the join has already laid each text's words, resolved for the flow (cast slots and
// {{ab:}}), over both twins. So the shared text a twin read is the one the vendored join shows (fixtures/master:
// master-A.json and master-B.json, checksummed and never edited):
//   - the word fields it holds are those that every twin naming it has. The text gives each field it holds to both
//     twins, so a field only one twin has is that step's own (B4-115's booking:sentnow variant: A4-98 has none). The
//     join cannot tell a field the text holds from one both twins set themselves (A7-06 and B7-10 each ask their own
//     question), so both count as the text's;
//   - it labels branch N when every twin has a branch N, and holds branch N's endText when every twin's has one;
//   - its words in a flow are the join's twin in that flow.
// A master twin that shows other words in those fields drifts. On the master as the join wrote it, none does: the join
// ran this check and found 0 errors (CHECKS.md: "Lint: 0 errors, 0 warnings, 24 allowed"). lib.js lintSteps has no
// L5: build-master.js sorts mergeShared's hits beside lintSteps' own (lintFlow, its lines 78-90).
//
// A trade's applied flow is not read. A trade writes its words per flow (SPEC-prof 3: `A.ops`, `B.ops`), its ops never
// name a shared text, and lib.js runs L5 on the master's parts alone.
import { isDeepStrictEqual } from "node:util";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { eachStep, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** The word fields a shared text may hold, in the order lib.js reads them (SHARED_WORDS). */
export const SHARED_WORDS = ["title", "does", "more", "say", "rule", "q", "form", "table", "vary"] as const;
export type SharedWord = (typeof SHARED_WORDS)[number];

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** One shared text, as the vendored join shows it. */
export interface SharedText {
  /** Its name: the flow A twin's id. */
  readonly name: string;
  /** The step that names it in each flow of the join. */
  readonly twins: Readonly<Partial<Record<FlowLetter, LintStep>>>;
  /** The word fields it holds: those every twin has. */
  readonly words: readonly SharedWord[];
  /** The branches (from 0) it labels: every twin has a branch there. */
  readonly labels: ReadonlySet<number>;
  /** The branches (from 0) whose endText it holds: every twin's branch there has one. */
  readonly endTexts: ReadonlySet<number>;
}

/** The shared text a step names, or undefined. */
export function textOf(step: LintStep): string | undefined {
  const text = "text" in step ? step.text : undefined;
  return typeof text === "string" && text !== "" ? text : undefined;
}

function hasEndText(step: LintStep, k: number): boolean {
  const end = step.branches?.[k]?.endText;
  return typeof end === "string" && end !== "";
}

let joined: ReadonlyMap<string, SharedText> | null = null;

/** Every shared text of the vendored join, by name. Read once: the vendored flows do not change. */
export function sharedTexts(): ReadonlyMap<string, SharedText> {
  if (joined !== null) return joined;
  const master = loadMaster();
  const named = new Map<string, Partial<Record<FlowLetter, LintStep>>>();
  for (const flow of FLOWS) {
    eachStep(master[flow].path, (step) => {
      const name = textOf(step);
      if (name === undefined) return;
      const twins = named.get(name) ?? {};
      twins[flow] = step;
      named.set(name, twins);
    });
  }
  const made = new Map<string, SharedText>();
  for (const [name, twins] of named) {
    const all = FLOWS.flatMap((flow) => twins[flow] ?? []);
    const branches = Math.min(...all.map((step) => step.branches?.length ?? 0));
    const indexes = Array.from({ length: branches }, (_, k) => k);
    made.set(name, {
      name,
      twins,
      words: SHARED_WORDS.filter((field) => all.every((step) => step[field] !== undefined)),
      labels: new Set(indexes),
      endTexts: new Set(indexes.filter((k) => all.every((step) => hasEndText(step, k)))),
    });
  }
  joined = made;
  return joined;
}

/** L5: a twin that drifts from its shared text. */
export const l5: LintRule = {
  id: "L5",
  name: "twin drift",
  source:
    "lib.js mergeShared lines 1704-1713, SHARED_WORDS line 1656; the shared texts as the vendored join shows them",
  run(ctx: LintContext): LintHit[] {
    if (ctx.trade !== null) return [];
    const texts = sharedTexts();
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      const name = textOf(step);
      const text = name === undefined ? undefined : texts.get(name);
      const twin = text?.twins[ctx.flow];
      if (text === undefined || twin === undefined) continue;
      const at = { rule: "L5", level: "error" as const, step: step.id };
      for (const field of text.words) {
        const own = step[field];
        if (own === undefined || isDeepStrictEqual(own, twin[field])) continue;
        hits.push({
          ...at,
          field,
          text: text.name,
          fix: `the words live in the shared text ${text.name}: take '${field}' off the step (a real twin difference: {{ab:A words|B words}} in the text, or addMore on the step)`,
        });
      }
      (step.branches ?? []).forEach((branch, k) => {
        const shared = twin.branches?.[k];
        if (shared === undefined) return;
        const where = `branch ${String(k + 1)}`;
        if (text.labels.has(k) && branch.label !== "" && branch.label !== shared.label)
          hits.push({
            ...at,
            field: `${where} label`,
            text: branch.label,
            fix: `the shared text ${text.name} names it '${shared.label}': leave the step's label empty ("")`,
          });
        const end = branch.endText;
        if (text.endTexts.has(k) && typeof end === "string" && end !== "" && end !== shared.endText)
          hits.push({
            ...at,
            field: `${where} endText`,
            text: end,
            fix: `the shared text ${text.name} has its endText: take it off the step`,
          });
      });
    }
    return hits;
  },
};
