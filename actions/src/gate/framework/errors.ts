// What the gate throws (T-298). Each message names limits, parts and labels only: never a quote's or a value's words
// (K-08 v1 README: "never the raw number or words").

import { NotBuiltError } from "../../tool-api/errors";
import type { GatedPart, LimitNumber } from "./types";

/**
 * A limit not built yet refused the turn's parts (the fail-closed stub). It is the Tool API base's NotBuiltError for
 * gateAndCommit, so the base answers `notBuilt` and rolls the call's transaction back: nothing is written and no part
 * passes. `parts` holds what the gate did with each part, for the trace and the tests.
 */
export class LimitNotBuiltError extends NotBuiltError {
  override name = "LimitNotBuiltError";
  /** The limits not built yet that refused a part, in order. */
  readonly limits: readonly LimitNumber[];
  readonly parts: readonly GatedPart[];

  constructor(limits: readonly LimitNumber[], parts: readonly GatedPart[]) {
    super("gateAndCommit");
    this.message = `gateAndCommit: limit ${limits.join(", ")} not built yet; ${String(parts.length)} parts, none passed`;
    this.limits = limits;
    this.parts = parts;
  }
}

/** Why a limit's answer breaks the gate's interface (a fault in the limit, never passed on). */
export type LimitFault =
  "unknownVerdict" | "wrongLimit" | "wrongAction" | "fieldNotCarried" | "noFields" | "wrongSlot";

/**
 * A limit answered outside its interface (types.ts LimitVerdict): another limit's outcome, an action with another kind,
 * a field the part does not carry, or limit 6 failing before decide's re-read without naming a field. The gate throws, so
 * the Tool API base rolls the call back and nothing passes.
 */
export class GateLimitError extends Error {
  override name = "GateLimitError";
  readonly limit: LimitNumber;
  readonly part: number | null;
  readonly fault: LimitFault;

  constructor(limit: LimitNumber, part: number | null, fault: LimitFault) {
    super(
      part === null
        ? `the gate's slot for limit ${String(limit)} holds another limit (${fault})`
        : `limit ${String(limit)} answered part ${String(part)} outside the gate's interface (${fault})`,
    );
    this.limit = limit;
    this.part = part;
    this.fault = fault;
  }
}
