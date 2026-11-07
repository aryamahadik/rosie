// The Linq double (T-411; C-211; K-11 v1; build prompt 3.2 and 9.4). Test code only: it makes no network call, reads no
// key, and logs nothing, so no word and no phone number leaves it. It implements the port's calls the double answers:
//
//   sendPart        records every request in order; answers accepted, or any failure the contract defines as the test
//                   chooses (4001, 4006, 403 with code 2024, a rate limit, a refusal, a transient error); refuses what
//                   K-11 refuses; records a repeated part under one idempotency key once (K-07 part keys); and after a
//                   403 with code 2024 fails every later send to that phone until reset (BP 9.4: a real STOP makes Linq
//                   block the phone for good, and override_optout does not lift it: README spike row 15)
//   contactAdd      added (a number already added answers alreadyContact) or failed, as the test chooses
//   capabilityCheck what a number supports, as the test chooses; imessage by default
//   fake receipts, poll votes and failures: data the test reads from events(); a sent or delivered receipt carries its
//                   part's key as partKey. Signed webhooks (doubleWebhook) are T-412's.

import type {
  CapabilityCheckOutcome,
  ContactAddOutcome,
  DoubleEvent,
  ScriptedCapability,
  ScriptedContactAdd,
  ScriptedSendFailure,
  SendPartFailed,
  SendPartOutcome,
  SendPartRequest,
} from "./types";
import { PHONE, sendPartProblems } from "./validate";

export interface LinqDoubleOptions {
  /** The clock, an RFC 3339 UTC time ending in Z. Default: the real clock, whole seconds. */
  readonly now?: () => string;
}

interface ScriptEntry<T> {
  readonly value: T;
  readonly phone: string | null;
  remaining: number;
}

export interface ScriptOptions {
  /** Only a send to this phone takes it. Default: any phone. */
  readonly to?: string;
  /** How many sends take it. Default: 1. */
  readonly times?: number;
}

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");

function failure(
  kind: SendPartFailed["kind"],
  httpStatus: number | null,
  code: string | null,
  reason: string,
  retryAfterSeconds: number | null = null,
): SendPartFailed {
  return { result: "failed", kind, httpStatus, code, reason, retryAfterSeconds, providerMessageId: null };
}

/** The contract's failure for a chosen kind: its status, code and a reason with no key, phone or words. */
function scriptedFailure(choice: ScriptedSendFailure): SendPartFailed {
  switch (choice.kind) {
    case "optedOut":
      return failure("optedOut", 403, "2024", "The recipient asked to stop.");
    case "mayStillDeliver":
      return failure(
        "mayStillDeliver",
        500,
        choice.code,
        choice.code === "4006" ? "Delivery timed out." : "Delivery failed.",
      );
    case "rateLimited":
      return failure("rateLimited", 429, "1007", "Rate limit.", choice.retryAfterSeconds ?? null);
    case "refused":
      return failure("refused", choice.httpStatus ?? 400, choice.code ?? "1004", "The request was refused.");
    case "transient":
      return failure(
        "transient",
        choice.httpStatus === undefined ? 503 : choice.httpStatus,
        null,
        "A server or network error.",
      );
  }
}

export class LinqDouble {
  readonly #now: () => string;
  #sent: SendPartRequest[] = [];
  #rejected: { request: unknown; problems: string[] }[] = [];
  #events: DoubleEvent[] = [];
  #contactRequests: string[] = [];
  #capabilityRequests: string[] = [];
  /** Key -> the stored outcome: Linq dedupes by it, and a repeat after 4006 returns the stored failure. */
  #stored = new Map<string, SendPartOutcome>();
  #keyChat = new Map<string, string>();
  #optedOut = new Set<string>();
  #contacts = new Set<string>();
  #sendScript: ScriptEntry<ScriptedSendFailure>[] = [];
  #contactScript: ScriptEntry<ScriptedContactAdd>[] = [];
  #capabilities = new Map<string, ScriptedCapability>();
  #serial = 0;

  constructor(options: LinqDoubleOptions = {}) {
    this.#now = options.now ?? defaultNow;
  }

  // ---- what the test chooses ----

  /** The next send (to `to`, if given) fails this way, `times` times. A 2024 also stops that phone. */
  failNextSend(choice: ScriptedSendFailure, options: ScriptOptions = {}): void {
    this.#sendScript.push({ value: choice, phone: options.to ?? null, remaining: options.times ?? 1 });
  }

  /** The next contact add (for `to`, if given) answers this way, `times` times. */
  scriptContactAdd(choice: ScriptedContactAdd, options: ScriptOptions = {}): void {
    this.#contactScript.push({ value: choice, phone: options.to ?? null, remaining: options.times ?? 1 });
  }

  /** What a number supports until reset: a check for it answers this. Default: iMessage. */
  setCapability(phone: string, choice: ScriptedCapability): void {
    this.#capabilities.set(phone, choice);
  }

  /** Clears one phone's opt-out block: the real block lifts only when the person texts again (README spike row 15). */
  liftOptOut(phone: string): void {
    this.#optedOut.delete(phone);
  }

  /** Back to a new double: no record, no script, no opt-out, no contact, no stored key. */
  reset(): void {
    this.#sent = [];
    this.#rejected = [];
    this.#events = [];
    this.#contactRequests = [];
    this.#capabilityRequests = [];
    this.#stored.clear();
    this.#keyChat.clear();
    this.#optedOut.clear();
    this.#contacts.clear();
    this.#sendScript = [];
    this.#contactScript = [];
    this.#capabilities.clear();
    this.#serial = 0;
  }

  // ---- what the test reads ----

  /** Every sendPart request the double took, in order, once per idempotency key (a typing call has no key and counts each time). */
  sentRequests(): readonly SendPartRequest[] {
    return structuredClone(this.#sent);
  }

  /** Requests K-11 refuses, in order, with the fields at fault (never their values). */
  rejectedRequests(): readonly { request: unknown; problems: string[] }[] {
    return structuredClone(this.#rejected);
  }

  /** The phones sent contactAdd for, in order. */
  contactAddRequests(): readonly string[] {
    return [...this.#contactRequests];
  }

  /** The phones sent capabilityCheck for, in order. */
  capabilityCheckRequests(): readonly string[] {
    return [...this.#capabilityRequests];
  }

  /** The faked receipts, votes and failures, in order. */
  events(): readonly DoubleEvent[] {
    return structuredClone(this.#events);
  }

  /** Whether the double now blocks sends to this phone (a 2024 happened and no reset or lift since). */
  isOptedOut(phone: string): boolean {
    return this.#optedOut.has(phone);
  }

  // ---- the port's calls ----

  sendPart(request: unknown): SendPartOutcome {
    const problems = sendPartProblems(request);
    if (problems.length > 0) {
      this.#rejected.push({ request: structuredClone(request), problems });
      return failure("refused", 400, "1004", "The request has no shape in the contract.");
    }
    const part = structuredClone(request as SendPartRequest);

    // A repeat under one key is Linq's dedupe: the stored answer, recorded once.
    const key = part.idempotencyKey;
    if (key !== null) {
      const stored = this.#stored.get(key);
      if (stored !== undefined) return structuredClone(stored);
    }
    this.#sent.push(part);
    if (key !== null) this.#keyChat.set(key, part.chatId);

    const script = this.#takeSend(part.to);
    if (script?.kind === "optedOut") this.#optedOut.add(part.to);
    // A stopped phone fails every later send, override_optout or not.
    if (this.#optedOut.has(part.to)) return scriptedFailure({ kind: "optedOut" });
    if (script !== undefined) {
      const failed = scriptedFailure(script);
      // Linq stores a 4001 or 4006 under the key: a repeat returns it, and a retry takes a new key.
      if (key !== null && script.kind === "mayStillDeliver") this.#stored.set(key, failed);
      return structuredClone(failed);
    }

    const accepted = this.#accept(part);
    if (key !== null) this.#stored.set(key, accepted);
    return structuredClone(accepted);
  }

  contactAdd(request: unknown): ContactAddOutcome {
    const phone =
      typeof request === "object" && request !== null && "phone" in request ? request.phone : undefined;
    if (typeof phone !== "string" || !PHONE.test(phone)) {
      return {
        result: "failed",
        phone: "+10000000000",
        retryable: false,
        code: "1002",
        reason: "The number is not in E.164 form.",
      };
    }
    this.#contactRequests.push(phone);
    const script = this.#takeContact(phone);
    if (script?.result === "failed") {
      return {
        result: "failed",
        phone,
        retryable: script.retryable,
        code: script.code ?? null,
        reason: script.reason ?? "Linq did not add the number.",
      };
    }
    const already = this.#contacts.has(phone);
    this.#contacts.add(phone);
    return {
      result: "added",
      phone,
      alreadyContact: already,
      providerContactId: script?.providerContactId ?? `linq-contact-double-${phone.slice(-4)}`,
    };
  }

  capabilityCheck(request: unknown): CapabilityCheckOutcome {
    const phone =
      typeof request === "object" && request !== null && "phone" in request ? request.phone : undefined;
    if (typeof phone !== "string" || !PHONE.test(phone)) {
      return {
        result: "failed",
        phone: "+10000000000",
        code: "1002",
        reason: "The number is not in E.164 form.",
      };
    }
    this.#capabilityRequests.push(phone);
    const chosen = this.#capabilities.get(phone) ?? {
      result: "checked",
      imessage: true,
      service: "imessage",
    };
    if (chosen.result === "failed")
      return {
        result: "failed",
        phone,
        code: chosen.code ?? null,
        reason: chosen.reason ?? "The check failed.",
      };
    return {
      result: "checked",
      phone,
      imessage: chosen.imessage,
      service: chosen.service,
      checkedAt: this.#now(),
      cacheSeconds: 600,
    };
  }

  // ---- faked events, as data ----

  /** Fakes message.sent for a part sent under `partKey`; the key rides as partKey. */
  fakeSent(partKey: string): DoubleEvent {
    return this.#receipt("sent", partKey);
  }

  /** Fakes message.delivered for a part sent under `partKey`; also the late receipt after a 4001 or 4006. */
  fakeDelivered(partKey: string): DoubleEvent {
    return this.#receipt("delivered", partKey);
  }

  /** Fakes a vote (or a removed vote) on a poll the double accepted; `optionId` must be one of its options. */
  fakePollVote(pollMessageId: string, optionId: string, voter: string, removed = false): DoubleEvent {
    const known = [...this.#stored.values()].some(
      (outcome) =>
        outcome.result === "accepted" &&
        outcome.providerMessageId === pollMessageId &&
        (outcome.providerOptionIds ?? []).includes(optionId),
    );
    if (!known) throw new Error("fakePollVote: no accepted poll has that message and option");
    return this.#record({
      kind: "pollVote",
      at: this.#now(),
      partKey: null,
      messageId: pollMessageId,
      optionId,
      voter,
      removed,
    });
  }

  /** Fakes message.failed (or poll.failed) for a part key, or for none; the code is Linq's, as text. */
  fakeFailure(code: string, partKey: string | null = null, reason = "Delivery failed."): DoubleEvent {
    return this.#record({
      kind: "failed",
      at: this.#now(),
      partKey,
      messageId: partKey === null ? null : this.#messageIdOf(partKey),
      code,
      reason,
    });
  }

  // ---- inside ----

  #takeSend(phone: string): ScriptedSendFailure | undefined {
    return this.#take(this.#sendScript, phone);
  }

  #takeContact(phone: string): ScriptedContactAdd | undefined {
    return this.#take(this.#contactScript, phone);
  }

  #take<T>(queue: ScriptEntry<T>[], phone: string): T | undefined {
    const index = queue.findIndex((entry) => entry.phone === null || entry.phone === phone);
    const entry = queue[index];
    if (entry === undefined) return undefined;
    entry.remaining -= 1;
    if (entry.remaining <= 0) queue.splice(index, 1);
    return entry.value;
  }

  #accept(part: SendPartRequest): SendPartOutcome {
    this.#serial += 1;
    const n = String(this.#serial).padStart(4, "0");
    const makesMessage = part.kind !== "tapback" && part.kind !== "typing";
    return {
      result: "accepted",
      providerMessageId: makesMessage ? `linq-msg-double-${n}` : null,
      providerOptionIds:
        part.kind === "poll"
          ? part.options.map((_option, index) => `linq-opt-double-${n}-${String(index + 1)}`)
          : null,
      chatId: part.chatId,
      service: part.kind === "typing" || part.kind === "tapback" ? null : part.service,
      acceptedAt: this.#now(),
    };
  }

  #messageIdOf(partKey: string): string | null {
    const stored = this.#stored.get(partKey);
    return stored?.result === "accepted" ? stored.providerMessageId : null;
  }

  #receipt(kind: "sent" | "delivered", partKey: string): DoubleEvent {
    const stored = this.#stored.get(partKey);
    if (stored === undefined) throw new Error(`fake ${kind}: no part was sent under that key`);
    return this.#record({
      kind,
      at: this.#now(),
      partKey,
      messageId: this.#messageIdOf(partKey),
      chatId: this.#keyChat.get(partKey) ?? "",
    });
  }

  #record(event: DoubleEvent): DoubleEvent {
    this.#events.push(structuredClone(event));
    return structuredClone(event);
  }
}

/** A new Linq double. */
export function createLinqDouble(options: LinqDoubleOptions = {}): LinqDouble {
  return new LinqDouble(options);
}
