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
// Nothing here logs, and nothing is put in a span or an error but a name: never a number, an entry, a key or a secret.

import { guardLinqSender, type LinqRosterEnv } from "@rosie/adapters/linq/roster";
import { createLinqSender, type LinqSender, type LinqSendEnv } from "@rosie/adapters/linq/send";

import { environmentOf } from "../picks";
import type { LinqSendCall, LinqVerifyInputs, PageWebhookSecret } from "../real";

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

/**
 * The Worker's Linq verify input (../root.ts workerRoot): LINQ_WEBHOOK_SECRET by name at each call, as before; and, only
 * on staging's real Linq line, the test-phone page's own secret beside it, TEST_PHONE_WEBHOOK_SECRET by name at each call
 * that needs it, which speaks only for a test phone. Anywhere else nothing more is read: production reads ENVIRONMENT
 * alone here.
 */
export function stagingLinqVerifyInputs(env: LinqLineEnv): LinqVerifyInputs {
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
  return { webhookSecret, pageSecret };
}
