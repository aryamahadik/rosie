// The parts the Linq double sent (T-465; C-148): each part as K-11 v1 sendPart took it, with the outcome the double gave
// when it is known, in the order sent. On staging, K-21 v1 testPhoneParts gives exactly this (`RecordedPart`); locally,
// RecordingLinqDouble records it as the Linq double (C-211, T-411) answers.
//
// What reached the person is counted per try (one K-07 key, `<row>/<part>/<try>`), never from accepted outcomes alone:
//   - a retry after a timeout or crash reuses its key (contracts/outbox-effects README, retry rule 1; part move pending ->
//     pending, "same key, attempts + 1"), and Linq dedupes by the key (contracts/port-linq README, sendPart), so a key
//     sent twice is one message, never a problem by itself;
//   - an accepted part reported failed goes again under its next key (K-07 row move sent -> checked, part move sent ->
//     failed; fixtures/outbox-poll-failed-plain.json), so the failed try did not reach the person. What says it failed is
//     K-07's part state when the outbox reader read the try's row (the settled record), else the Linq double's last
//     report about it (its events: fakeFailure, as eventFromDoubleEvent carries it to the gateway);
//   - a try that failed with 4001 or 4006 and then got its receipt did reach the person (K-07 retry rule 2).
// A part (`<row>/<part>`) that reached the person twice is a duplicate send (build prompt section 10, D-017).
//
// A part's words are the person's to read in a test, never the driver's to print: checkParts reports keys, message ids
// and counts.

import { LinqDouble, sendPartProblems, type LinqDoubleOptions } from "../../../adapters/src/linq/double";
import type { DoubleEvent, SendPartOutcome, SendPartRequest } from "../../../adapters/src/linq/double/types";
import type { OutboxLife } from "../../../contracts/generated/outbox-effects/outbox-effects.v1";

/** One part sent: K-21 v1's RecordedPart, with `at` and `outcome` null where the double that sent it keeps none. */
export interface SentPart {
  readonly at: string | null;
  readonly sent: SendPartRequest;
  readonly outcome: SendPartOutcome | null;
}

const wholeSeconds = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");

export interface RecordingLinqDoubleOptions extends LinqDoubleOptions {
  /**
   * Record every sendPart request, a repeat under a key the double already holds too, as K-11 v1's README says the
   * double does ("records every sendPart request in order"). Default false: C-211's own record, in which a repeat under
   * a stored key is Linq's dedupe and is recorded once (adapters/src/linq/double/double.ts, sendPart). A request K-11
   * refuses is never a part either way (the double's rejectedRequests).
   */
  readonly recordRepeats?: boolean;
}

/** The Linq double, recording each part it takes with the outcome it gave (K-21 testPhoneParts' record). */
export class RecordingLinqDouble extends LinqDouble {
  readonly #clock: () => string;
  readonly #recordRepeats: boolean;
  #parts: SentPart[] = [];

  constructor(options: RecordingLinqDoubleOptions = {}) {
    super(options);
    this.#clock = options.now ?? wholeSeconds;
    this.#recordRepeats = options.recordRepeats ?? false;
  }

  override sendPart(request: unknown): SendPartOutcome {
    const before = this.sentRequests().length;
    const outcome = super.sendPart(request);
    const taken = this.sentRequests();
    const sent =
      taken.length > before
        ? taken[taken.length - 1]
        : this.#recordRepeats && sendPartProblems(request).length === 0
          ? structuredClone(request as SendPartRequest)
          : undefined;
    if (sent !== undefined) {
      this.#parts.push({ at: this.#clock(), sent, outcome: structuredClone(outcome) });
    }
    return outcome;
  }

  /** Each part taken, in order, with the outcome given. */
  recordedParts(): readonly SentPart[] {
    return structuredClone(this.#parts);
  }

  override reset(): void {
    super.reset();
    this.#parts = [];
  }
}

/** The parts a Linq double sent: its record when it keeps one, else its requests with no outcome. */
export function partsOf(linq: LinqDouble): SentPart[] {
  if (linq instanceof RecordingLinqDouble) return [...linq.recordedParts()];
  return linq.sentRequests().map((sent) => ({ at: null, sent, outcome: null }));
}

/** What says how a try ended, beside its own outcomes. */
export interface PartReports {
  /**
   * The Linq double's faked receipts and failures, in order (LinqDouble.events()): a receipt names its try's key; a
   * failure names its key, or the message id the double gave the try. Null or left out: the target reads none (K-21 v1
   * testPhoneParts gives none on staging).
   */
  readonly events?: readonly DoubleEvent[] | null;
  /** K-07 v1 outbox rows read under the trace: each try's part state by its key. Null or left out: none read. */
  readonly rows?: readonly OutboxLife[] | null;
}

/** One message that reached the person (or is on its way): its try's key, and the provider's message id or null. */
export interface Delivery {
  readonly key: string;
  readonly messageId: string | null;
}

/** A part (`<row>/<part>` of K-07's `<row>/<part>/<try>` key) and its messages that reached the person, in order. */
export interface PartDeliveries {
  readonly part: string;
  readonly deliveries: readonly Delivery[];
}

export interface PartsCheck {
  /** Parts recorded, typing dots and repeats included. */
  readonly parts: number;
  /**
   * Messages that reached the person (or are on their way): a key sent again counts once while Linq gave it one message
   * id, as its dedupe does.
   */
  readonly sends: number;
  /** Each part that reached the person more than once, with those messages: a duplicate send. */
  readonly duplicateSends: readonly PartDeliveries[];
  /**
   * Each part sent as more than one message where nothing read could say one of them failed (no K-07 part state and no
   * failure report for it): one delivery cannot be shown, and a duplicate cannot be claimed either.
   */
  readonly unjudgedSends: readonly PartDeliveries[];
  /** Each key sent more than once: K-07's retry on the same key, which Linq dedupes. Never a problem by itself. */
  readonly repeatedKeys: readonly string[];
}

/** One key's record: what the provider gave it and the last report about it. */
interface Try {
  readonly key: string;
  /** The message ids of its accepted outcomes, each once, in order. */
  readonly messageIds: string[];
  /** Accepted at least once, or taken by a double that keeps no outcome. */
  taken: boolean;
  /** The double's last receipt or failure about it, in the order of its events. */
  lastReport: "sent" | "delivered" | "failed" | null;
  /** How many records carry the key. */
  records: number;
}

/** A try's verdict: whether it reached the person, and whether anything read could have said it failed. */
interface Verdict {
  readonly live: boolean;
  readonly judged: boolean;
}

const partOf = (key: string): string => key.split("/").slice(0, -1).join("/");

/**
 * Counts what reached the person and finds duplicate sends. A try reached the person when K-07's part state says sent or
 * delivered; when its part state is failed, or the double's last report about it is a failure, it did not; otherwise it
 * did when the provider accepted it (or a receipt came for it). A part with two such messages is a duplicate when K-07's
 * part states or the double's reports were read for them, else unjudged. Typing dots carry no key and are not judged.
 */
export function checkParts(parts: readonly SentPart[], reports: PartReports = {}): PartsCheck {
  const tries = new Map<string, Try>();
  for (const { sent, outcome } of parts) {
    const key = sent.idempotencyKey;
    if (key === null) continue;
    const one = tries.get(key) ?? { key, messageIds: [], taken: false, lastReport: null, records: 0 };
    one.records += 1;
    if (outcome === null || outcome.result === "accepted") {
      one.taken = true;
      const id = outcome?.providerMessageId ?? null;
      if (id !== null && !one.messageIds.includes(id)) one.messageIds.push(id);
    }
    tries.set(key, one);
  }

  const events = reports.events ?? null;
  for (const event of events ?? []) {
    if (event.kind !== "sent" && event.kind !== "delivered" && event.kind !== "failed") continue;
    const byKey = event.partKey === null ? undefined : tries.get(event.partKey);
    const byMessage = [...tries.values()].find(
      (one) => event.messageId !== null && one.messageIds.includes(event.messageId),
    );
    const about = byKey ?? byMessage;
    if (about !== undefined) about.lastReport = event.kind;
  }

  const states = new Map<string, OutboxLife["parts"][number]["state"]>();
  for (const life of reports.rows ?? []) {
    for (const part of life.parts) states.set(part.idempotencyKey, part.state);
  }

  const verdict = (one: Try): Verdict => {
    const state = states.get(one.key);
    if (state === "failed") return { live: false, judged: true };
    if (state === "sent" || state === "delivered") return { live: true, judged: true };
    if (events !== null) {
      if (one.lastReport === "failed") return { live: false, judged: true };
      return { live: one.taken || one.lastReport !== null, judged: true };
    }
    // Pending under K-07, or no report read: what the provider gave it.
    return { live: one.taken, judged: state !== undefined };
  };

  const byPart = new Map<string, { deliveries: Delivery[]; judged: boolean }>();
  for (const one of tries.values()) {
    const { live, judged } = verdict(one);
    if (!live) continue;
    const part = partOf(one.key);
    const entry = byPart.get(part) ?? { deliveries: [], judged: true };
    const ids = one.messageIds.length === 0 ? [null] : one.messageIds;
    entry.deliveries.push(...ids.map((messageId) => ({ key: one.key, messageId })));
    entry.judged = entry.judged && judged;
    byPart.set(part, entry);
  }

  let sends = 0;
  const duplicateSends: PartDeliveries[] = [];
  const unjudgedSends: PartDeliveries[] = [];
  for (const [part, { deliveries, judged }] of byPart) {
    sends += deliveries.length;
    if (deliveries.length < 2) continue;
    (judged ? duplicateSends : unjudgedSends).push({ part, deliveries });
  }
  const repeatedKeys = [...tries.values()].filter((one) => one.records > 1).map((one) => one.key);
  return { parts: parts.length, sends, duplicateSends, unjudgedSends, repeatedKeys };
}

/** A delivery as a problem line names it: its key, and the provider's message id when there is one. */
export function deliveryName(delivery: Delivery): string {
  return delivery.messageId === null ? delivery.key : `${delivery.key} (${delivery.messageId})`;
}
