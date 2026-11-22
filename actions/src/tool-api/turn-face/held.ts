// What the turn face holds of a turn it was handed (T-1141; K-05 v1.3 item 35 and default 47: "the words a row answers
// are handed in by the runtime caller, never opened by a Tool API path"). The handle actor opens its turn's sealed texts
// under the handle's key and hands their words to the Tool API in the turn's own requests (gateAndCommit's
// input.decided.context.texts); the face holds them, with the turn's agreed language (decide's), once the turn's commit
// is answered, so compose input can give the composer the words of the text a row replies to, only in a reply to their
// own sender (rows.ts inboundOf). Nothing here reads a database, logs or puts a word in a span.
//
// The memory is the isolate's own and bounded: the newest MAX_HELD turns, each kept until it is pushed out, so a rerun
// after the actor let its texts go gets no inbound text (K-05 v1.3 item 35: "a compose rerun after the actor has let a
// turn's texts go gets no inbound text"), never another turn's.
//
// The secure link (T-1533; K-09 README default 211; DL-1167 (3)): S1-10's writer mints the code at the walk, and K-21
// has the code hand "the code to the slot filler (C-088) ... in the same run; the code is stored nowhere but in the
// message that carries it". No frozen K-09 shape carries it from gateAndCommit to finalizeMessage, so the face holds it
// between those two calls of the one turn, as it holds the texts: HeldLinks. The writer stages the plain link by its
// turn and the id of the outbox row that carries it, replaced at the same row id on every gate run (row ids repeat
// across GATE_RUNS); the face drops a turn's staged links when its gateAndCommit starts and ends, and moves into its hold
// only those whose row the committed answer lists, with repeated false (turn-face.ts), so a refusal, a throw, a repeat or
// a conflict's first run hands on no code. Finalize's slot facts read the held link for its row (rows.ts), and the face
// lets it go once that row's finalize has answered send, sendAndLog or passedOn. Both maps are bounded by MAX_HELD, the
// oldest going first. A link is never logged, put in a span or named in an error.

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How many turns the face holds the words of: far past one handle's turn and its reply (arch 01 line 61). */
export const MAX_HELD = 64;

/** One text's words and when it was sent, as K-02's context carries them. */
export interface HeldText {
  readonly words: string;
  readonly sentAt: { readonly utc: string; readonly zone: string };
}

/** What the face holds of one turn: the handle its texts came from, each text by event id, and the agreed language. */
export interface HeldTurn {
  readonly handleId: string;
  readonly texts: ReadonlyMap<string, HeldText>;
  readonly language: string | null;
}

/** The texts and language of a gateAndCommit request of decided texts, or null for any other request. */
export function heldTurnOf(request: unknown): { turnId: string; turn: HeldTurn } | null {
  if (!isRecord(request) || !isRecord(request.turn) || !isRecord(request.input)) return null;
  const { turn, input } = request;
  if (typeof turn.id !== "string" || typeof turn.handleId !== "string") return null;
  if (input.kind !== "decided" || !isRecord(input.decided)) return null;
  const { context, decide } = input.decided;
  if (!isRecord(context) || !Array.isArray(context.texts)) return null;
  const texts = new Map<string, HeldText>();
  for (const text of context.texts as unknown[]) {
    if (!isRecord(text) || typeof text.eventId !== "string" || typeof text.words !== "string") continue;
    const sentAt = text.sentAt;
    if (!isRecord(sentAt) || typeof sentAt.utc !== "string" || typeof sentAt.zone !== "string") continue;
    texts.set(text.eventId, { words: text.words, sentAt: { utc: sentAt.utc, zone: sentAt.zone } });
  }
  const language = isRecord(decide) && typeof decide.language === "string" ? decide.language : null;
  return { turnId: turn.id, turn: { handleId: turn.handleId, texts, language } };
}

/** The turns the face holds, newest last, at most `max`. */
export class HeldTurns {
  private readonly turns = new Map<string, HeldTurn>();

  constructor(private readonly max: number = MAX_HELD) {}

  /** Holds a turn's words and language; the oldest turn goes once more than `max` are held. */
  hold(turnId: string, turn: HeldTurn): void {
    this.turns.delete(turnId);
    this.turns.set(turnId, turn);
    while (this.turns.size > this.max) {
      const [oldest] = this.turns.keys();
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  /** The turn's words and language, or null when the face does not hold them. */
  of(turnId: string): HeldTurn | null {
    return this.turns.get(turnId) ?? null;
  }

  /** How many turns are held. */
  get size(): number {
    return this.turns.size;
  }
}

/** Sets `key` to `value` as the newest entry of `map`, the oldest going once more than `max` are kept. */
function keepNewest<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const [oldest] = map.keys();
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The secure links the face holds (the top of this file): staged by the writer for a turn's gate run, held for finalize
 * once that turn's commit is answered fresh, and let go once the row's finalize has answered. Never logged.
 */
export class HeldLinks {
  /** The links staged by turn id, each by the id of the outbox row that carries it. */
  private readonly staged = new Map<string, Map<string, string>>();
  /** The links held for finalize, by outbox row id. */
  private readonly links = new Map<string, string>();

  constructor(private readonly max: number = MAX_HELD) {}

  /** S1-10's writer's stage (mobile-id LinkStage): the link for `outboxRowId` of `turnId`, replacing one staged there. */
  stage(turnId: string, outboxRowId: string, link: string): void {
    const byRow = this.staged.get(turnId) ?? new Map<string, string>();
    byRow.set(outboxRowId, link);
    keepNewest(this.staged, turnId, byRow, this.max);
  }

  /** Drops every link staged for `turnId` (a gateAndCommit starting or ending). */
  dropStaged(turnId: string): void {
    this.staged.delete(turnId);
  }

  /**
   * A fresh commit of `turnId`: each link staged for one of `outboxRowIds` (the rows the commit wrote) moves into the
   * hold; every other link staged for the turn is dropped.
   */
  keep(turnId: string, outboxRowIds: readonly string[]): void {
    const byRow = this.staged.get(turnId);
    this.staged.delete(turnId);
    if (byRow === undefined) return;
    for (const rowId of outboxRowIds) {
      const link = byRow.get(rowId);
      if (link !== undefined) keepNewest(this.links, rowId, link, this.max);
    }
  }

  /** The link held for the outbox row `outboxRowId`, or null. */
  of(outboxRowId: string): string | null {
    return this.links.get(outboxRowId) ?? null;
  }

  /** Lets the row's link go (its finalize answered send, sendAndLog or passedOn). */
  letGo(outboxRowId: string): void {
    this.links.delete(outboxRowId);
  }

  /** How many links are held for finalize. */
  get size(): number {
    return this.links.size;
  }

  /** How many turns have links staged. */
  get stagedTurns(): number {
    return this.staged.size;
  }
}
