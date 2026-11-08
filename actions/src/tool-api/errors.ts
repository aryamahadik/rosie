// What the Tool API base refuses itself (T-290).
//
// K-09 v1's errors are each call's own (`$defs/<call>.errors`, each "Refused, nothing written"). None of them says that a
// request breaks its schema, that it names no business to scope the call by, or that a call has no handler yet, so the
// base answers those in the contract's error shape (02-contracts section 2 item 2: "Each is a JSON object with its own
// 'error' code") with codes of its own. Nothing is read or written for any of them: each is answered before the business
// scope opens, or (notBuilt) inside it, rolled back. README of this package, defaults; a K-09 minor version may adopt them.

import type { CallName } from "./calls";

/** The name is no call of K-09 v1. The name itself is not echoed: it is the caller's text. */
export interface UnknownCallRefusal {
  error: "unknownCall";
}

/** The request breaks `$defs/<call>.request`, or names another trace than the one the call runs in. */
export interface InvalidRequestRefusal {
  error: "invalidRequest";
  call: CallName;
  /** One line per problem: a path and what the schema wants, never a value. */
  problems: string[];
}

/**
 * The request names no business (`caller.businessId` null, or no caller at all, as plannerVerbs, which rides inside
 * gateAndCommit): row-level security scopes every Tool API call by its business (arch 10 line 546; K-04 v1 rule 4), so
 * the base never runs a call unscoped.
 */
export interface NoBusinessScopeRefusal {
  error: "noBusinessScope";
  call: CallName;
}

/** The call is registered but its handler is not built yet (each call's logic is T-291 onward). */
export interface NotBuiltRefusal {
  error: "notBuilt";
  call: CallName;
}

export type BaseRefusal =
  UnknownCallRefusal | InvalidRequestRefusal | NoBusinessScopeRefusal | NotBuiltRefusal;

/** The base's own error codes; no K-09 v1 call answers one of them. */
export const BASE_REFUSAL_CODES = ["unknownCall", "invalidRequest", "noBusinessScope", "notBuilt"] as const;

export function isBaseRefusal(value: unknown): value is BaseRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (BASE_REFUSAL_CODES as readonly unknown[]).includes((value as { error?: unknown }).error)
  );
}

/**
 * A handler answered something its call's response and errors both refuse. That is a fault in the handler, so the answer
 * is never passed on: the call's transaction is rolled back and this is thrown. The problem lines name paths, never values.
 */
export class ToolApiContractError extends Error {
  override name = "ToolApiContractError";
  readonly call: CallName;
  readonly problems: readonly string[];

  constructor(call: CallName, problems: readonly string[]) {
    super(`${call}'s handler answered outside K-09 v1 (${String(problems.length)} problems)`);
    this.call = call;
    this.problems = problems;
  }
}

/** What a handler not built yet throws; the base answers it as notBuilt, with the call's transaction rolled back. */
export class NotBuiltError extends Error {
  override name = "NotBuiltError";
  readonly call: CallName;

  constructor(call: CallName) {
    super(`${call} has no handler yet (T-291 onward)`);
    this.call = call;
  }
}
