// The e2e-workers project's global setup (T-1149): it runs in Node, reads SKELETON_UPTO and CONTRACT_REPORT there
// (./plan.ts), and provides the plan to the skeleton's run inside workerd, which reads it with Vitest's inject.

import type { TestProject } from "vitest/node";

import { SKELETON_PLAN, skeletonPlanOf } from "./plan";

export default function setup(project: TestProject): void {
  project.provide(SKELETON_PLAN, skeletonPlanOf(process.env));
}
