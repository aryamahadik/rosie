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
