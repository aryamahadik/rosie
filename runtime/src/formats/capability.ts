// The capability check's 10-minute cache (T-261; C-128). Arch 07 line 365: the channel comes "from the service of the
// text a reply answers, else Linq's capability check, cached 10 minutes, or text alone if it fails"; K-11 v1
// capabilityCheck: "the caller caches it for 10 minutes" (cacheSeconds 600).
//
//   - One answer per number, kept 10 minutes from when it came. A lookup inside them asks Linq nothing; one at 10 minutes
//     or later asks again.
//   - Lookups made while a check for the number is still out share that check, so the rows of one turn, composed in
//     parallel (arch 07 line 397), ask Linq once.
//   - A failed check, a thrown or rejected call, or an answer K-11 does not name (another number's, a service outside
//     K-11's list) is no answer: the lookup says failed, which is text alone, and nothing is kept, so the next lookup asks
//     again.
//   - Answers 10 minutes old are dropped as lookups come, so the cache holds only live answers and checks still out.
//
// Nothing here logs and nothing here throws. The number is the cache's key and goes only to the port; no span, log line
// or error ever holds it (the lead's rule for T-261: never log a number or a chat id).

import type { Capability, CapabilityCheckPort, CapabilityLookup, LinqService } from "./types";

/** How long an answer is kept: 10 minutes (arch 07 line 365; K-11 v1 capabilityCheck.response cacheSeconds 600). */
export const CAPABILITY_CACHE_MS = 600_000;

/** The services K-11 v1 names (`service`). */
const SERVICES: ReadonlySet<unknown> = new Set<LinqService>(["imessage", "rcs", "sms"]);

/** What a K-11 answer says, kept per number. */
interface Answer {
  readonly imessage: boolean;
  readonly service: LinqService | null;
}

type Entry =
  | { readonly kind: "out"; readonly answer: Promise<Answer | null> }
  | { readonly kind: "kept"; readonly answer: Answer; readonly until: number };

const FAILED = { result: "failed" } as const;

/** A K-11 v1 capabilityCheck.response for this number, else null: a failure, or anything K-11 does not name. */
function answerOf(outcome: unknown, phone: string): Answer | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const answer = outcome as Record<string, unknown>;
  if (answer.result !== "checked" || answer.phone !== phone || typeof answer.imessage !== "boolean")
    return null;
  if (answer.service !== null && !SERVICES.has(answer.service)) return null;
  return { imessage: answer.imessage, service: answer.service as LinqService | null };
}

function capabilityOf(answer: Answer | null, cached: boolean): Capability {
  return answer === null
    ? { ...FAILED, cached }
    : { result: "checked", imessage: answer.imessage, service: answer.service, cached };
}

export interface CapabilityCacheOptions {
  /** The clock, in milliseconds since the epoch. Default: Date.now. */
  readonly now?: () => number;
}

/** Linq's capability check, each number's answer kept 10 minutes (arch 07 line 365). */
export class CapabilityCache implements CapabilityLookup {
  readonly #port: CapabilityCheckPort;
  readonly #now: () => number;
  /** By number, in the order each was kept or asked for, so the oldest answers come first. */
  readonly #entries = new Map<string, Entry>();

  constructor(port: CapabilityCheckPort, options: CapabilityCacheOptions = {}) {
    this.#port = port;
    this.#now = options.now ?? Date.now;
  }

  /** How many numbers it holds now: answers under 10 minutes old and checks still out. */
  get size(): number {
    return this.#entries.size;
  }

  /** What the number takes now: a kept answer under 10 minutes old, a check already out, or a new check. */
  async lookup(phone: string): Promise<Capability> {
    const now = this.#now();
    this.#dropOld(now);
    const entry = this.#entries.get(phone);
    if (entry?.kind === "kept" && now < entry.until) return capabilityOf(entry.answer, true);
    if (entry?.kind === "out") return capabilityOf(await entry.answer, true);

    const out: Entry = { kind: "out", answer: this.#check(phone) };
    this.#entries.set(phone, out);
    const answer = await out.answer;
    if (this.#entries.get(phone) === out) {
      this.#entries.delete(phone);
      if (answer !== null) {
        this.#entries.set(phone, { kind: "kept", answer, until: this.#now() + CAPABILITY_CACHE_MS });
      }
    }
    return capabilityOf(answer, false);
  }

  /** One call to the port; a throw, a rejection or an answer K-11 does not name is null. */
  async #check(phone: string): Promise<Answer | null> {
    try {
      return answerOf(await this.#port.capabilityCheck({ phone }), phone);
    } catch {
      return null;
    }
  }

  /**
   * Drops the answers 10 minutes old from the front (the oldest), up to the first live answer. A check still out is
   * passed over, never dropped, so one that is slow to answer keeps no old answer behind it.
   */
  #dropOld(now: number): void {
    for (const [phone, entry] of this.#entries) {
      if (entry.kind === "out") continue;
      if (now < entry.until) return;
      this.#entries.delete(phone);
    }
  }
}
