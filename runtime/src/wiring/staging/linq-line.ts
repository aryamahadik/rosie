// Staging's real Linq line beside the test-phone line (T-1449; DL-937, DL-940; D-018, the lane to the user texting Rosie
// from their own iPhone: DL-914). Before it, staging's send was bound to the test-phone line alone (./send.ts, T-1401:
// "until J-08 brings the real adapter") and the gateway's Linq verify read one secret, LINQ_WEBHOOK_SECRET, which the
// test-phone page's Linq double signed with too. Behind one switch, staging now sends a roster phone's parts through
// T-414's sender behind T-416's guard and checks Linq's own webhooks, while the test-phone page keeps its line and signs
// with a secret of its own (K-11 v1 README, doubleWebhook: "Signed with the test environment's secret, never Linq's").
//
// The switch (realLinqLineOn): STAGING_LINQ_LINE, read by name as unknown (T-572 sets it on staging; typed here, never by
// wrangler's types). The real line is on only where ENVIRONMENT is staging (../picks.ts environmentOf, checked first, so
// production reads nothing more) and STAGING_LINQ_LINE is exactly "real". Absent, "double", "" or any other value: every
// path is as it was before this card, and no name below but the switch's is read.
//
// Who is a test phone (isTestPhone), one rule for both directions: a number in the +1 fiction range (an area code that is
// not toll-free, then 555-0100 to 555-0199, as infra/ci/phone-scan.mjs's FICTIONAL_PHONE reads it: T-1359) that is not on
// STAGING_LINQ_ALLOWLIST and is not Rosie's own line (ROSIE_NUMBER, compared exactly). The list is read at each call as
// T-416's guard reads it (adapters/src/linq/roster: split on "," alone, no trimming, each entry E.164; its parser is not
// exported, so it is read again here, the same way): missing, not text or blank, it names no number, so no number is on
// it; holding any entry that is not E.164, it cannot be read, so no number is taken for a test phone (the guard refuses
// every real send then as well). The roster phones, the real ones, are exactly the list, so a test phone is never a roster
// phone; and Rosie's own line is never a destination (T-416), so it is never a test phone either.
//
// Sends (linqLineSend: ./send.ts's linqSendCall, its all-or-nothing rule unchanged): with the real line on, a part to a
// test phone goes to the test-phone line exactly as before; every other part goes through
// guardLinqSender(createLinqSender({ env }), { env }) (guardedLinqSender, made at the first part it sends), which reads
// LINQ_API_TOKEN, STAGING_LINQ_ALLOWLIST and ROSIE_NUMBER by name at each call: a roster phone gets the real send, and any
// other number (a stranger who texts Rosie's line, an ill-formed `to`, Rosie's own line) is refused by the guard before
// any request; a missing name fails closed. Its answer goes back through ../real.ts linqAnswerOf as any line's does. A
// test phone never reaches Linq, and a roster phone never reaches the test-phone line.
//
// Inbound (stagingLinqVerifyInputs: ../root.ts workerRoot's `linq` input, which ../real.ts linqVerify reads): with the
// real line on, LINQ_WEBHOOK_SECRET is Linq's own signing secret for staging's subscription (K-11 README default 1),
// accepted from any sender, and TEST_PHONE_WEBHOOK_SECRET is the test-phone page's own, which the page's signer signs
// with (../root.ts, the page join), accepted only when the K-06 event's sender is a test phone. Anything else is K-11's
// rejected badSignature (401), with the same timestamp rules for both. A missing secret fails closed as before
// (MissingSecretError, naming the name alone). With the real line off, the page and the verify use LINQ_WEBHOOK_SECRET
// alone, exactly as before.
//
// The chat lookup (chatHandleLookup, T-1456; K-05 v1.10 item 51, the audit's CHAT; CQ-61): on the real line Linq posts
// its receipts (message.sent, message.delivered, message.failed, poll.failed) and Rosie's own reactions with the chat id,
// not the person's number, and the adapter asks ParseLookups.chatHandle for it (adapters/src/linq/webhook/parse.ts
// receiptHandle). Where the real line is on, the root hands its one database handle (../root.ts workerRoot, the handle
// staging's parts run on, the chat open among them: ./k05-receipt.ts) and HYPERDRIVE_JOB is bound (its presence alone,
// once, as the chat open checks it), the verify's chatHandle is db/repo/threads.ts readChatHandle on that handle's
// runtime side: one client from HYPERDRIVE_JOB as rosie_worker_job, one read-only transaction, nothing written. A chat a
// thread of kind chat holds, whose handle is a phone, answers its number (E.164), so its receipt becomes its K-06 event
// and reaches its door as any event does. An unknown chat answers null (an answer, not an error: K-05 default 95), a
// transient read answers null, and a call that cannot be made throws, scrubbed; for each the adapter throws
// receiptHandleUnknown and the gateway answers 503, so Linq retries (a receipt can arrive before its chat is written).
// The lookup is handed the chat id alone, so its timing line (./part.ts dbCallLine) names no trace. Elsewhere (the line
// off, production, no handle handed, or no HYPERDRIVE_JOB) no lookup is bound, as before. The test-phone page's secret
// and its rule are unchanged: ../real.ts hands the page's verify the same lookup, and the page's own events (texts) never
// ask it.
//
// Nothing here logs, and nothing is put in a span or an error but a name: never a number, an entry, a key, a secret or a
// chat id.

import { guardLinqSender, type LinqRosterEnv } from "@rosie/adapters/linq/roster";
import { createLinqSender, type LinqSender, type LinqSendEnv } from "@rosie/adapters/linq/send";
import { scrubbed } from "@rosie/db/repo/clocks";
import { readChatHandle, type ReadChatHandleOutcome } from "@rosie/db/repo/threads";

import { environmentOf } from "../picks";
import type { LinqSendCall, LinqVerifyInputs, PageWebhookSecret } from "../real";
import type { StagingDb } from "./part";

/** The switch's name (DL-940): T-572 sets it on staging. */
export const STAGING_LINQ_LINE = "STAGING_LINQ_LINE";
/** The one value of the switch that turns the real line on. */
export const REAL_LINQ_LINE = "real";
/** The test-phone page's own webhook secret's name (DL-940): T-572 makes it and sets it on staging. */
export const TEST_PHONE_WEBHOOK_SECRET = "TEST_PHONE_WEBHOOK_SECRET";

/**
 * The Worker's env as this file and the two adapters read it, each name read by name at its call: typed here, since
 * T-572 sets the switch, the list and the secrets on staging and wrangler's types name none of them.
 */
export interface LinqLineEnv extends LinqSendEnv, LinqRosterEnv {
  readonly ENVIRONMENT: string;
  readonly STAGING_LINQ_LINE?: unknown;
  /** K-11's webhook secret, as ../root.ts WorkerSecrets types it: Linq's own where the real line is on. */
  readonly LINQ_WEBHOOK_SECRET?: string;
  readonly TEST_PHONE_WEBHOOK_SECRET?: unknown;
  /** The runtime side's binding (./db.ts DbEnv): its presence alone is read here, for the chat lookup (T-1456). */
  readonly HYPERDRIVE_JOB?: unknown;
}

/** Whether staging's real Linq line is on: ENVIRONMENT staging (read first) and STAGING_LINQ_LINE exactly "real". */
export function realLinqLineOn(env: Pick<LinqLineEnv, "ENVIRONMENT" | "STAGING_LINQ_LINE">): boolean {
  return environmentOf(env) === "staging" && env.STAGING_LINQ_LINE === REAL_LINQ_LINE;
}

/**
 * The toll-free area codes, where a 555-01xx line is no fiction (infra/ci/phone-scan.mjs TOLL_FREE_AREA_CODES, T-1359):
 * 800, 833, 844, 855, 866, 877 and 888 in use, and 822, 880 to 887 and 889 kept for toll-free's growth.
 */
const TOLL_FREE_AREA_CODES = [
  ...["800", "833", "844", "855", "866", "877", "888"],
  ...["822", "880", "881", "882", "883", "884", "885", "886", "887", "889"],
];

/** The +1 fiction range in E.164: +1, an area code that is not toll-free, then 555-0100 to 555-0199. */
const FICTION_RANGE = new RegExp(
  String.raw`^\+1(?!(?:${TOLL_FREE_AREA_CODES.join("|")}))[2-9][0-9]{2}55501[0-9]{2}$`,
  "u",
);

/** K-11's phone ($defs/phone), the form T-416's guard asks of every entry of the list. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;

/**
 * STAGING_LINQ_ALLOWLIST's entries as T-416's guard reads them: none where it is missing, not text or blank; the entries,
 * split on "," alone with no trimming, where each is E.164; null where any entry is not (the list cannot be read).
 */
function allowListOf(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.trim() === "") return [];
  const entries = value.split(",");
  return entries.every((entry) => E164.test(entry)) ? entries : null;
}

/**
 * Whether `number` is a test phone (the header's rule): in the +1 fiction range, not on STAGING_LINQ_ALLOWLIST, and not
 * ROSIE_NUMBER; never while the list cannot be read. Both names are read at each call, and only for a number in the
 * range.
 */
export function isTestPhone(
  env: Pick<LinqLineEnv, "STAGING_LINQ_ALLOWLIST" | "ROSIE_NUMBER">,
  number: unknown,
): boolean {
  if (typeof number !== "string" || !FICTION_RANGE.test(number)) return false;
  const listed = allowListOf(env.STAGING_LINQ_ALLOWLIST);
  if (listed === null || listed.includes(number)) return false;
  return number !== env.ROSIE_NUMBER;
}

/**
 * T-414's sender behind T-416's guard over the Worker's env, as T-416's handoff wires it: neither reads a name as it is
 * made; at each send the guard reads ENVIRONMENT, STAGING_LINQ_ALLOWLIST and ROSIE_NUMBER, and the sender LINQ_API_TOKEN.
 */
export function guardedLinqSender(env: LinqLineEnv): LinqSender {
  return guardLinqSender(createLinqSender({ env }), { env });
}

export interface LinqLineSeams {
  /**
   * How the real sender is made, once, at the first part it sends. Left out: guardedLinqSender. A test stands in a maker
   * that counts, to see it is never made while the real line is off.
   */
  readonly realSender?: (env: LinqLineEnv) => LinqSender;
}

/**
 * Staging's K-11 sendPart by recipient (./send.ts's linqSendCall): the switch read at each part; off, every part goes to
 * `testPhoneLine` as before and nothing more is read; on, a part to a test phone goes there too, and every other part
 * goes through the guarded real sender, made at the first such part.
 */
export function linqLineSend(
  env: LinqLineEnv,
  testPhoneLine: LinqSendCall,
  seams: LinqLineSeams = {},
): LinqSendCall {
  let real: LinqSender | null = null;
  return (request) => {
    if (!realLinqLineOn(env) || isTestPhone(env, request.to)) return testPhoneLine(request);
    real ??= (seams.realSender ?? guardedLinqSender)(env);
    return real.sendPart(request);
  };
}

/** K-05 v1.10 readChatHandle's name on the root's handle (T-1456): on its timing line, and on every error that leaves it. */
export const READ_CHAT_HANDLE_CALL = "readChatHandle";

/** The number readChatHandle answers for a chat a thread of kind chat holds, whose handle is a phone; null for any other answer. */
function numberOf(answer: ReadChatHandleOutcome): string | null {
  return "handle" in answer && answer.handle !== null ? answer.handle.address : null;
}

/**
 * The real line's chat lookup (the header's; T-1456): ParseLookups.chatHandle as db/repo/threads.ts readChatHandle
 * answers it, on `db`'s runtime side (the root's handle: one client from HYPERDRIVE_JOB for each call, read-only, nothing
 * written). The chat's number (E.164) when a thread of kind chat holds the chat id and its handle is a phone; null for an
 * unknown chat (K-05 default 94) and for a transient read. A call that cannot be made (the handle's refusal, a connect that
 * fails, a database error) throws, scrubbed as ./k05-receipt.ts scrubs its calls' (db/repo/clocks.ts scrubbed: the call's
 * name and a SQLSTATE or the client's code). The chat id goes to the read alone: never into an answer, an error or a log.
 */
export function chatHandleLookup(db: StagingDb): (chatId: string) => Promise<string | null> {
  return async (chatId) => {
    let answer: ReadChatHandleOutcome;
    try {
      answer = await db.runtime(READ_CHAT_HANDLE_CALL, (sql) => readChatHandle(sql, { linqChatId: chatId }));
    } catch (error) {
      throw scrubbed(READ_CHAT_HANDLE_CALL, error);
    }
    return numberOf(answer);
  };
}

/**
 * The Worker's Linq verify input (../root.ts workerRoot): LINQ_WEBHOOK_SECRET by name at each call, as before; and, only
 * on staging's real Linq line, the test-phone page's own secret beside it, TEST_PHONE_WEBHOOK_SECRET by name at each call
 * that needs it, which speaks only for a test phone; and there, where the root hands its handle (`db`) and HYPERDRIVE_JOB
 * is bound, the chat lookup (chatHandleLookup, T-1456). Anywhere else nothing more is read: production reads ENVIRONMENT
 * alone here. Making it reads ENVIRONMENT, the switch and, on the real line with a handle handed, the presence of
 * HYPERDRIVE_JOB; no secret, no connection string, and no database call.
 */
export function stagingLinqVerifyInputs(env: LinqLineEnv, db?: StagingDb): LinqVerifyInputs {
  const webhookSecret = (): string | undefined => env.LINQ_WEBHOOK_SECRET;
  if (!realLinqLineOn(env)) return { webhookSecret };
  const pageSecret: PageWebhookSecret = {
    name: TEST_PHONE_WEBHOOK_SECRET,
    secret: () => {
      const secret = env.TEST_PHONE_WEBHOOK_SECRET;
      return typeof secret === "string" ? secret : undefined;
    },
    speaksFor: (sender) => sender.kind === "phone" && isTestPhone(env, sender.address),
  };
  if (db === undefined) return { webhookSecret, pageSecret };
  // The binding's presence, once, as the root is built (./k05-receipt.ts reads it so for the chat open); its connection
  // string is the handle's to read, at each call.
  const binding: unknown = env.HYPERDRIVE_JOB;
  if (binding === undefined || binding === null) return { webhookSecret, pageSecret };
  return { webhookSecret, pageSecret, chatHandle: chatHandleLookup(db) };
}
