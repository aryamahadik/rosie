// Test support for the allowed formats (T-261): a fake clock, a capability check answered by K-11 v1's capability.json,
// K-04 v1's seed phones as the formats read them, and K-06 v1 events as the actor stores the text a turn answers. Test
// code only. Values come from the contracts' fixtures (rule 9): the fictional 555-01xx numbers and their seed handles.
import seedPhones from "@rosie/contracts/db-schema/core/fixtures/seed-phone-chat-open.json";
import seedStopped from "@rosie/contracts/db-schema/core/fixtures/seed-phone-stopped.json";
import capabilityFixture from "@rosie/contracts/port-linq/fixtures/capability.json";

import type {
  AnsweredText,
  CapabilityAnswer,
  CapabilityCheckPort,
  InboundKind,
  InboundService,
  PhoneRecipient,
} from "./types";

/** K-04 v1's seed phones (seed-phone-chat-open.json; seed-phone-stopped.json). */
export const SAM = "+15555550100";
/** Alex has voted in a poll (poll_voted_at 2026-10-23T14:06:10Z). */
export const ALEX = "+15555550101";
/** Riley has not voted in a poll. */
export const RILEY = "+15555550102";
export const AVERY = "+15555550103";
/** Tomás's chat is RCS; capability.json checks his number. */
export const TOMAS = "+15555550105";
/** Ben sent STOP, so his chat is closed (chat_open false). */
export const BEN = "+15555550106";

/** A fake clock in milliseconds, started at capability.json's `given.now`. */
export function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let ms = Date.parse(capabilityFixture.given.now);
  return {
    now: () => ms,
    advance: (by) => {
      ms += by;
    },
  };
}

/** A port that answers capability.json's outcome, and keeps each number it was asked for. */
export function fixturePort(): { port: CapabilityCheckPort; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    port: {
      capabilityCheck: ({ phone }) => {
        asked.push(phone);
        return structuredClone(capabilityFixture.outcome) as CapabilityAnswer;
      },
    },
  };
}

interface SeedRow {
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
}

const SEED_ROWS = [...seedPhones.rows, ...seedStopped.rows] as readonly SeedRow[];

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("a seed phone's field is not text");
  return value;
}

/** A seed phone as the formats read it: its handle, its number, whether its chat is open and whether it has voted. */
export function seedPhone(number: string): PhoneRecipient {
  const row = SEED_ROWS.find(
    (candidate) => candidate.table === "phones" && candidate.values.number === number,
  );
  if (row === undefined) throw new Error("no such seed phone");
  return {
    kind: "phone",
    handleId: textOf(row.values.handle_id),
    phone: textOf(row.values.number),
    chatOpen: row.values.chat_open === true,
    votedInPoll: typeof row.values.poll_voted_at === "string",
  };
}

/** The text a turn answers as the actor stores it from a K-06 v1 event: its sender's handle, its service and kind. */
export function answeredOf(event: {
  readonly handle: { readonly address: string };
  readonly service: string | null;
  readonly kind: string;
}): AnsweredText {
  return {
    fromHandleId: seedPhone(event.handle.address).handleId,
    service: event.service as InboundService | null,
    kind: event.kind as InboundKind,
  };
}

/** A text from this phone, as Linq reports it on a service (K-06 v1 service and kind). */
export function textFrom(
  phone: PhoneRecipient,
  service: InboundService | null,
  kind: InboundKind = "text",
): AnsweredText {
  return { fromHandleId: phone.handleId, service, kind };
}
