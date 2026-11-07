// The recorded-model double itself (T-004, C-123): a lookup of recorded answers by request. It has no network, no clock
// and no randomness; the same request gives the same answer, byte for byte.

import { NoRecordingError } from "./errors";
import { requestKey } from "./key";
import type {
  DecideRead,
  DecideRequest,
  PlannerOutput,
  PlannerRequest,
  RecordedModel,
  RecordingKind,
  SafetyRead,
  SafetyReadRequest,
} from "./types";

interface Held {
  readonly output: unknown;
}

/** A promise settled by `fn`: it resolves with what `fn` returns and rejects with what it throws. */
const settle = <T>(fn: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(fn());
  });

/** Builds the double over recordings already checked and keyed (recordings.ts is the only caller that checks them). */
export function createRecordedModel(held: ReadonlyMap<string, Held>): RecordedModel {
  const replay = <T>(kind: RecordingKind, request: unknown): Promise<T> =>
    settle(() => {
      const key = requestKey(kind, request);
      const found = held.get(key);
      if (found === undefined) throw new NoRecordingError(kind, key);
      return structuredClone(found.output) as T;
    });
  return {
    safetyRead: (request: SafetyReadRequest): Promise<SafetyRead> =>
      replay("safetyRead", { text: request.text }),
    decide: (request: DecideRequest): Promise<DecideRead> =>
      replay("decideRead", { context: request.context, role: request.role }),
    planner: (request: PlannerRequest): Promise<PlannerOutput> =>
      replay("plannerOutput", { context: request.context }),
    size: held.size,
  };
}
