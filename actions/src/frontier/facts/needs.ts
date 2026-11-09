// What a step needs (T-295): K-01 v1 step.needs, "the keys it uses; it may only need what an earlier step gave on every
// path to it" (SPEC-master 4 'needs'), read from the flow graph of the bundle the step's choice comes from: an open
// question's options from the bundle it was asked under (K-04 open_questions.bundle_hash, bundle_build), a hub's cases
// from the turn's pinned bundle. The assembler's step view (assemble/bundle.ts) keeps only what the choices read, so the
// graph is read again here, through the same bundles port, once per bundle and flow for the call, and only when a home
// is listed (facts.ts). A value that is not K-01's graph, or a step it does not hold, needs nothing.

import { bundleKey, type BundleId, type FlowLetter, type FrontierBundles } from "../assemble/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One step's K-01 v1 needs in a flow graph, or null when the value is not that flow's graph or holds no such step. */
export function needsIn(graph: unknown, flow: FlowLetter, stepId: string): string[] | null {
  if (!isRecord(graph) || graph.contract !== "bundle.v1" || graph.flow !== flow) return null;
  const steps = isRecord(graph.steps) ? graph.steps : {};
  const step = Object.hasOwn(steps, stepId) ? steps[stepId] : undefined;
  if (!isRecord(step) || (step.id !== undefined && step.id !== stepId)) return null;
  const needs: unknown[] = Array.isArray(step.needs) ? step.needs : [];
  return needs.filter((key): key is string => typeof key === "string" && key !== "");
}

/** The flows a step is looked for in: its own (an A or B step), else the context's first (a shared S step). */
function flowsOf(stepId: string, contextFlow: FlowLetter): FlowLetter[] {
  if (stepId.startsWith("A")) return ["A"];
  if (stepId.startsWith("B")) return ["B"];
  return contextFlow === "A" ? ["A", "B"] : ["B", "A"];
}

/** Reads steps' needs for one call: each bundle's flow graph read once, on first need. */
export function needsReader(
  bundles: FrontierBundles,
  contextFlow: FlowLetter,
): (bundleId: BundleId, stepId: string) => Promise<string[]> {
  const graphs = new Map<string, Promise<unknown>>();
  const graphOf = (bundleId: BundleId, flow: FlowLetter): Promise<unknown> => {
    const key = `${bundleKey(bundleId)}/${flow}`;
    let graph = graphs.get(key);
    if (graph === undefined) {
      graph = bundles.flow(bundleId, flow);
      graphs.set(key, graph);
    }
    return graph;
  };
  return async (bundleId, stepId) => {
    for (const flow of flowsOf(stepId, contextFlow)) {
      const needs = needsIn(await graphOf(bundleId, flow), flow, stepId);
      if (needs !== null) return needs;
    }
    return [];
  };
}
