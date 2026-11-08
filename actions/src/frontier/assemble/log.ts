// The frontier's log (T-291): one JSON line per thing the frontier left out, so a source that is not built, throws or
// offers what K-02 v1 refuses, and an open question that cannot be offered, are each seen, never silent (fail closed).
//
// Every value is a label (K-08's label rule, runtime/src/trace isLabel): an event name, a source slot, an error's kind,
// a count, and ids (trace, turn, open question, step, booking). Never a choice's label or definition, a text, a name, a
// handle or a business's name (K-08 v1 "Never the raw number or words"): a value that is not a label is written as
// "unlabelled", whatever a caller passes.

import { isLabel } from "../../../../runtime/src/trace";
import type { FrontierEvent, FrontierLogger, LogFields } from "./types";

/** One line of the frontier's log. */
export interface FrontierLogLine {
  level: "warn";
  msg: FrontierEvent;
  trace_id: string;
  turn_id: string;
  source?: string;
  error?: string;
  problems?: number;
  open_question_id?: string;
  step?: string;
  booking_id?: string;
}

/** Where the lines go. Default: one JSON line each on console.warn. */
export type FrontierLogSink = (line: FrontierLogLine) => void;

export function consoleSink(line: FrontierLogLine): void {
  console.warn(JSON.stringify(line));
}

/** The value itself when it is a label, else "unlabelled". */
function label(value: string): string {
  return isLabel(value) ? value : "unlabelled";
}

/** A logger for one call, naming its trace and turn on every line. */
export function frontierLogger(
  sink: FrontierLogSink,
  ids: { traceId: string; turnId: string },
): FrontierLogger {
  return {
    warn(event: FrontierEvent, fields: LogFields = {}): void {
      const line: FrontierLogLine = {
        level: "warn",
        msg: event,
        trace_id: label(ids.traceId),
        turn_id: label(ids.turnId),
      };
      if (fields.source !== undefined) line.source = label(fields.source);
      if (fields.error !== undefined) line.error = label(fields.error);
      if (fields.problems !== undefined) line.problems = fields.problems;
      if (fields.open_question_id !== undefined) line.open_question_id = label(fields.open_question_id);
      if (fields.step !== undefined) line.step = label(fields.step);
      if (fields.booking_id !== undefined) line.booking_id = label(fields.booking_id);
      try {
        sink(line);
      } catch {
        // A log sink that fails never changes the frontier's answer.
      }
    },
  };
}
