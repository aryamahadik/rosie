// The master's overlay core, loaded as it is (T-135; NQ-PB-2 answered WRAP by T-131).
//
// fixtures/master/engine/work/build/overlay-core.js is the ONE place where a profession's overlay is applied. The
// applier calls its apply() and never copies its rules. The script is read-only (rule 1) and is loaded unchanged
// through cjs-load.ts.
import { fileURLToPath } from "node:url";
import type { FlowLetter } from "../graph/types.ts";
import { makeCjsLoader } from "./cjs-load";

/** Where fixture set v1 keeps the master's build scripts, from the repository root. */
export const BUILD_DIR = fileURLToPath(
  new URL("../../../fixtures/master/engine/work/build/", import.meta.url),
);

/** What overlay-core.js apply() hands back: `{ flow, errors }`, plus `slotProblems` when the slots found any. */
export interface CoreApplyResult {
  flow: unknown;
  errors: string[];
  slotProblems?: string[];
}

/** The part of overlay-core.js this build calls. */
export interface OverlayCore {
  apply(master: unknown, overlay: unknown, flow: FlowLetter): CoreApplyResult;
}

let cached: OverlayCore | null = null;

/** Loads overlay-core.js once per process and returns its apply(). Throws if the script does not offer apply(). */
export function loadOverlayCore(): OverlayCore {
  if (cached) return cached;
  const exported = makeCjsLoader()(`${BUILD_DIR}overlay-core.js`) as Partial<OverlayCore> | null;
  if (typeof exported?.apply !== "function")
    throw new Error(`${BUILD_DIR}overlay-core.js does not export apply()`);
  const core = exported as OverlayCore;
  cached = core;
  return core;
}
