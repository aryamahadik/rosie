// sendProofCode (K-09 v1; T-322; C-095; RULES 6.2; S13-45; S11-52; MC C9): a code to the contact on file, as an email
// outbox row, or by asking the person to text it from that mobile, never a first text.
//
// For one call made alone, in this order, each step answering before anything is written:
//   1. a repeat (the caller's request id) answers the first send and writes nothing (K-09: "a repeat answers with the
//      same code row, not a new code");
//   2. the contact is one of the person's own handles on file (K-04 person_handles, T-307's reads; T-308's contact on
//      file) of the route's kind: an email address for emailOnFile, a mobile for textFromMobile; else noContactOnFile;
//   3. the contact's limits (K-22 v1 proof_code_limits): its pause for this purpose answers paused until its end, and
//      the day's codes to it (every person and purpose) at the cap answer paused;
//   4. the code is drawn (draw.ts) and hashed through the root's port (hashing.ts); it lives only in the words from here;
//   5. one write, all or nothing (ProofCodeStore.commitSend): the K-22 v1 code row with only its keyed hash, and on an
//      email route the email row with its plan and final parts and three entries (ADR-016 section 1). On textFromMobile
//      no outbox row is built at all: the page shows the ready text, which the person texts from that mobile, since that
//      text proves it and Rosie never writes first (MC C9; RULES 4.1b). No route of K-09 v1 texts a code, so no text
//      outbox row is ever built here, to a mobile with an open chat or without one.
//
// The code itself never comes back on an email route (K-09), and never reaches an entry, a span or a log: the email
// row's final parts and a textFromMobile answer's ready text are the only places it is (K-08 v1.1 proof_code.sent).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A typed or texted code is hashed with its white space taken out ("482 913" is 482913), nothing else changed.
//   2. A repeat of a textFromMobile send answers readyText null: only the code's hash is kept, so the code is never
//      shown twice; the person asks for a new code.
//   3. Only a sign-in code has words in the sources (ADR-016 section 1; K-09 proof-code-text-from-mobile.json), so any
//      other purpose answers notBuilt, writing nothing. So do the typedEmail and listingEmail routes (they write a K-04
//      handle and K-22's accounts.email, or read K-23's listing email: not this card's reads) and a turn's call (it rides
//      in the turn's one commit, which has no list for a code row yet).
//   4. The day's cap is 5 codes to one contact in a rolling 24 hours, every person and purpose (S13-45: "At most a few
//      codes a day per contact"; ADR-016 open point 1), read through K-22 v1 proof_code_limits; at the cap the answer is
//      paused until 24 hours from now, since proof_code_limits gives no earliest send (the longest wait is named).
//   5. Every entry's why is step S13-45 (K-08 v1.1 event-proof-code-sent.json), and its actor Rosie.

import type { EventEntry } from "../../commit";
import { NotBuiltError, type AnswerOf, type RequestOf } from "../../tool-api";
import type { MessagesReader } from "../messages-consent";
import { drawCode, type RandomFill } from "./draw";
import { codeHashOf, type KeyedHash } from "./hashing";
import type { CodeEmail, CodeRow, CodeSend, ProofCodeIds, ProofCodeStore, SentCode } from "./ports";
import {
  CODES_PER_CONTACT_PER_DAY,
  DAY_HOURS,
  STORED_PURPOSE,
  channelOf,
  dayWindowStartOf,
  expiresAtOf,
  msOf,
  utcOf,
  type Purpose,
} from "./rules";
import { codeFinalParts, codeRowPlan, wordsFor } from "./words";

export type SendRequest = RequestOf<"sendProofCode">;
export type SendAnswer = AnswerOf<"sendProofCode">;

/** The routes a code goes by to a contact already on file. */
export type OnFileRoute = "emailOnFile" | "textFromMobile";

/** What one send is built from: who and where, under which key and trace, at which time. */
export interface CodeSendInput {
  /** The key a repeat is known by: the caller's request id. */
  readonly key: string;
  readonly traceId: string;
  readonly purpose: Purpose;
  readonly route: OnFileRoute;
  /** The person the code proves (K-09 forPersonId), set by the server. */
  readonly personId: string;
  /** The business the code's words name; null for a sign-in code (K-09 README "Proof codes in K-22 v1"). */
  readonly businessId: string | null;
  /** The contact on file it goes to (K-04 handles.id): an email address, or the mobile it proves. */
  readonly handleId: string;
  /** When it is made: an instant in UTC ending in Z. */
  readonly now: string;
}

/** What building a send needs. */
export interface CodeSendTools {
  readonly hash: KeyedHash;
  readonly random: RandomFill;
  readonly ids: ProofCodeIds;
}

/** One send built: what the store writes, and the ready text the person texts (MC C9), or null on an email route. */
export interface BuiltSend {
  readonly send: CodeSend;
  /** Holds the code: never logged, never in a span or an entry. */
  readonly readyText: string | null;
}

/** The send's entries name the step of the proof rule (default 5). */
const WHY = { step: "S13-45" } as const;

/** One entry Rosie writes for a send (K-05 v1 eventEntry, in K-08 v1.1's kinds), its id in build.ts's form. */
function entry(
  rowId: string,
  move: string,
  kind: string,
  tableName: string,
  businessId: string | null,
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown>,
): EventEntry {
  return {
    id: `log-${rowId}-${move}`,
    kind,
    zone: null,
    businessId,
    actorKind: "rosie",
    actorPersonId: null,
    actorRole: null,
    tableName,
    rowId,
    oldValues,
    newValues,
    sealed: null,
    why: { ...WHY },
    approvedBy: null,
    proofs: null,
  };
}

/**
 * The entries of one send (ADR-016 section 1, "The entries"): the email row made planned and then checked, and the code
 * sent, as K-08 v1.1 names proof_code.sent's values (team only: no business). None holds the plan, the final parts, the
 * code, its hash or an address.
 */
function sendEntries(input: CodeSendInput, code: CodeRow, email: CodeEmail | null): EventEntry[] {
  const events: EventEntry[] = [];
  if (email !== null) {
    const { id, businessId } = email.row;
    events.push(
      entry(id, "created", "outbox_row.created", "outbox_rows", businessId, null, {
        state: "planned",
        channel: "email",
        send_class: "quick_reply",
      }),
      entry(
        id,
        "planned",
        "outbox_row.planned",
        "outbox_rows",
        businessId,
        { state: "planned" },
        { state: "checked" },
      ),
    );
  }
  events.push(
    entry(code.id, "sent", "proof_code.sent", "proof_codes", null, null, {
      person_id: input.personId,
      purpose: input.purpose,
      route: input.route,
      contact_handle_id: input.handleId,
      expires_at: code.expires_at,
      wrong_tries: 0,
    }),
  );
  return events;
}

/**
 * One send: a fresh code, its row with only the keyed hash, and on an email route the email row with its words, or on
 * textFromMobile the ready text (no outbox row: MC C9). Refused (notBuilt) for a purpose the sources give no words for.
 */
export async function buildCodeSend(input: CodeSendInput, tools: CodeSendTools): Promise<BuiltSend> {
  const words = wordsFor(input.purpose);
  if (words === null) throw new NotBuiltError("sendProofCode");
  const channel = channelOf(input.route);
  const code = drawCode(tools.random);
  const row: CodeRow = {
    id: await tools.ids.codeId(input.key),
    purpose: STORED_PURPOSE[input.purpose],
    person_id: input.personId,
    business_id: input.businessId,
    sent_to_handle_id: input.handleId,
    channel,
    code_hash: await codeHashOf(tools.hash, code),
    hash_key_name: tools.hash.keyName,
    sent_at: input.now,
    expires_at: expiresAtOf(input.now),
  };
  let email: CodeEmail | null = null;
  let readyText: string | null = null;
  if (channel === "email") {
    const rowId = await tools.ids.emailRowId(input.key);
    email = {
      row: {
        id: rowId,
        recipientHandleId: input.handleId,
        recipientPersonId: input.personId,
        businessId: input.businessId,
        bookingId: null,
        channel: "email",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
        emailPurpose: "code",
        notAfter: row.expires_at,
      },
      plan: codeRowPlan(rowId),
      finalParts: codeFinalParts(rowId, words.email(code)),
    };
  } else {
    readyText = words.readyText(code);
  }
  return {
    send: {
      key: input.key,
      traceId: input.traceId,
      code: row,
      email,
      events: sendEntries(input, row, email),
    },
    readyText,
  };
}

/** What sendProofCode reads and writes through. */
export interface SendDeps {
  readonly store: ProofCodeStore;
  /** T-307's K-04 reads (the person's handles and each handle's kind), made only once a send gets that far. */
  readonly reader: () => MessagesReader;
  /** The root's hashing port; null: none bound, so nothing is sent (notBuilt). */
  readonly hash: KeyedHash | null;
  readonly random: RandomFill;
  readonly ids: ProofCodeIds;
}

/** What a repeat answers: the first send's code row, never the code (default 2). */
function repeatOf(first: SentCode): SendAnswer {
  return {
    proofCodeId: first.proofCodeId,
    expiresAt: first.expiresAt,
    outboxRowId: first.outboxRowId,
    readyText: null,
    repeated: true,
  };
}

/** The send's answer, and the rows it wrote (for the call's span: ids only). */
export interface SendOutcome {
  readonly answer: SendAnswer;
  readonly wrote: readonly { readonly table: string; readonly id: string }[];
}

/** sendProofCode for one call made alone, at `now`. */
export async function sendProofCode(request: SendRequest, now: string, deps: SendDeps): Promise<SendOutcome> {
  const answered = (answer: SendAnswer): SendOutcome => ({ answer, wrote: [] });
  const { caller, route } = request;
  if (caller.kind === "turn") throw new NotBuiltError("sendProofCode");
  if (route !== "emailOnFile" && route !== "textFromMobile") throw new NotBuiltError("sendProofCode");
  if (wordsFor(request.purpose) === null) throw new NotBuiltError("sendProofCode");
  if (deps.hash === null) throw new NotBuiltError("sendProofCode");
  const personId = request.forPersonId;
  if (personId === null) throw new NotBuiltError("sendProofCode");
  const handleId = request.contactHandleId;
  if (handleId === null) return answered({ error: "noContactOnFile" });

  const key = caller.requestId;
  const first = await deps.store.sentFor(key);
  if (first !== null) return answered(repeatOf(first));

  const reader = deps.reader();
  const own = await reader.handleIdsOfPerson(personId);
  const handle = own.includes(handleId) ? await reader.handle(handleId) : null;
  const kind = route === "emailOnFile" ? "email" : "phone";
  if (handle?.id !== handleId || handle.kind !== kind) return answered({ error: "noContactOnFile" });

  const purpose = STORED_PURPOSE[request.purpose];
  const limits = await deps.store.limits({ handleId, purpose, since: dayWindowStartOf(now), at: now });
  if (limits.pausedUntil !== null && msOf(limits.pausedUntil) > msOf(now)) {
    return answered({ error: "paused", until: limits.pausedUntil });
  }
  if (limits.sentSince >= CODES_PER_CONTACT_PER_DAY) {
    return answered({ error: "paused", until: utcOf(msOf(now) + DAY_HOURS * 3_600_000) });
  }

  const built = await buildCodeSend(
    {
      key,
      traceId: caller.traceId,
      purpose: request.purpose,
      route,
      personId,
      businessId: request.purpose === "signIn" ? null : caller.businessId,
      handleId,
      now,
    },
    { hash: deps.hash, random: deps.random, ids: deps.ids },
  );
  const committed = await deps.store.commitSend(built.send);
  if ("error" in committed) return answered(committed);
  if (committed.repeated) return answered(repeatOf(committed.first));
  const { code, email } = built.send;
  return {
    answer: {
      proofCodeId: code.id,
      expiresAt: code.expires_at,
      outboxRowId: email === null ? null : email.row.id,
      readyText: built.readyText,
      repeated: false,
    },
    wrote: [
      { table: "proof_codes", id: code.id },
      ...(email === null ? [] : [{ table: "outbox_rows", id: email.row.id }]),
    ],
  };
}
