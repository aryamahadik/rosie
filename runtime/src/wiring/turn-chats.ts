// The service and Linq chat id of each run's last text (T-559; K-09 v1.5 README default 135; ADR-013 section 4; DL-333
// ruling 1): the runtime caller of gateAndCommit, the handle actor's turn (C-046), puts them on the request's turn, copied
// from the K-06 v1 event of the turn's last text, the last of its event ids, both or neither (K-09 v1.5
// gateAndCommit.turn). The commit's walk reads them there: S1-01's thread row takes the chat id as K-04
// threads.linq_chat_id, its one home, and a reply's outbox row takes the service as its channel (default 132). The commit
// writes the turn row with K-05's seven fields alone.
//
// The turn builds its request on K-05's turn (runtime/src/turn/turn.ts: `run.ref`), which carries neither, so the root's
// lease hooks keep each run's last text's service and chat id under the run's trace before the run starts (as
// ./pinned-runs.ts keeps its bundle), and the root's gateAndCommit puts them on the request's turn by the trace it is
// handed (the run's own: turn.ts hands every Tool API call `run.trace`). A trace that is no run's (a call from anywhere
// else, a clock's turn), a last event whose service is no string, or a chat id that is neither a string nor null: neither
// is put, and the walk fails a part that needs them closed, never guessed. Nothing is made up: a chat id Linq did not
// report stays null (K-06 v1 chatId). The memory is weak: a run's entry goes with its trace. Never logged, and never put
// in a span, an error or K-02's context: the chat id.

import type { LeaseHooks, LeasedTurn } from "../actor/lease";
import type { TraceContext } from "../trace";
import type { GateAndCommitRequest } from "../turn/types";

/** The service and Linq chat id of a turn's last text, as K-09 v1.5's gateAndCommit.turn takes them. */
export interface TextSource {
  /** K-06 v1 service: imessage, rcs or sms through Linq, or email. */
  readonly service: string;
  /** K-06 v1 chatId: Linq's id for the chat, or null when Linq did not report it (and for email). */
  readonly chatId: string | null;
}

/**
 * The K-06 event of the turn's last text (the last of its event ids, in arrival order) as the inbox keeps it, sealed: its
 * service and chat id, both or neither. Null when the turn has no such entry, its service is no non-empty string, or its
 * chat id is neither a non-empty string nor null.
 */
export function lastTextSourceOf(turn: Pick<LeasedTurn, "eventIds" | "entries">): TextSource | null {
  const last = turn.eventIds.at(-1);
  if (last === undefined) return null;
  const entry = turn.entries.find((candidate) => candidate.event.eventId === last);
  if (entry === undefined) return null;
  const service: unknown = entry.event.service;
  const chatId: unknown = entry.event.chatId;
  if (typeof service !== "string" || service === "") return null;
  if (chatId === null) return { service, chatId: null };
  if (typeof chatId !== "string" || chatId === "") return null;
  return { service, chatId };
}

/** The request with the text source on its turn, both fields, or the request as it is when there is none (neither). */
export function withTextSource(
  request: GateAndCommitRequest,
  source: TextSource | null,
): GateAndCommitRequest {
  if (source === null) return request;
  const turn = { ...request.turn, service: source.service, chatId: source.chatId };
  return { ...request, turn };
}

export class TurnChats {
  private readonly runs = new WeakMap<TraceContext, TextSource>();

  /** The lease's hooks with each run's last text's service and chat id kept under its trace before the run's work starts. */
  around(hooks: Required<LeaseHooks>): Required<LeaseHooks> {
    return {
      ...hooks,
      runTurn: (turn) => {
        const source = lastTextSourceOf(turn);
        if (source === null) this.runs.delete(turn.trace);
        else this.runs.set(turn.trace, source);
        return hooks.runTurn(turn);
      },
    };
  }

  /** The service and chat id of the last text of the run whose trace this is; null for a trace that is no run's. */
  of(trace: TraceContext): TextSource | null {
    return this.runs.get(trace) ?? null;
  }

  /** The gateAndCommit request with its run's text source on its turn (both), or as it is (neither). */
  onTurn(request: GateAndCommitRequest, trace: TraceContext): GateAndCommitRequest {
    return withTextSource(request, this.of(trace));
  }
}
