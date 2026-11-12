// Doubles for the proof-code service's tests (T-322). Never imported by the Worker. No database: the store is a double of
// K-22 v1's proof_codes written from the contract and migration 0020 as they stand (check_proof_code and
// proof_code_limits line by line, the CHECKs a send's row must pass), with its own numbers, never the service's rules.ts,
// so a test of the service never checks the service against itself. Values come only from the fixtures (the master's
// sample cast, the 555-01xx range and example.com: rule 9); the hashing key is a fixed test pattern, not a secret.

import { createHmac } from "node:crypto";

import type { EventEntry } from "../../commit";
import type { MessagesReader } from "../messages-consent";
import type { RandomFill } from "./draw";
import { PROOF_CODE_HASH_PREFIX, hmacSha256Hash, type KeyedHash } from "./hashing";
import type {
  CheckAsk,
  CheckResult,
  CodeLimits,
  CodeSend,
  LimitsAsk,
  ProofCodeIds,
  ProofCodeStore,
  SendCommitAnswer,
  SentCode,
} from "./ports";
import type { CodeState } from "./rules";

// ---- the hashing key -------------------------------------------------------------------------------------------------

/** The test's key name: the name K-22 v1's fixtures use (seed-proof-code.json). */
export const TEST_KEY_NAME = "PROOF_CODE_HASH_KEY";

/** A fixed 32-byte pattern standing in for the secret: bytes 0 to 31. Not a key of any environment. */
export const TEST_KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);

/** The hashing port over the test pattern, as the root binds it over the real secret. */
export function testHash(): Promise<KeyedHash> {
  return hmacSha256Hash(TEST_KEY_NAME, TEST_KEY_BYTES);
}

/** The code's hash by Node's own HMAC, apart from the port: what the store must hold for `code`. */
export function nodeCodeHash(code: string): string {
  return createHmac("sha256", TEST_KEY_BYTES)
    .update(`${PROOF_CODE_HASH_PREFIX}${code}`, "utf8")
    .digest("hex");
}

// ---- random sources ----------------------------------------------------------------------------------------------

/** A fill that gives these 32-bit draws in order, and records every array it was asked to fill. */
export interface ScriptedFill {
  readonly fill: RandomFill;
  /** Each fill asked for: the array's kind and length. */
  readonly asked: { readonly kind: "uint8" | "uint32"; readonly length: number }[];
}

/**
 * Gives `draws` in order to a Uint32Array, one per element, and to a Uint8Array the low byte of each; a draw past the
 * last throws, so a test sees exactly how many were taken.
 */
export function scriptedFill(draws: readonly number[]): ScriptedFill {
  const asked: ScriptedFill["asked"] = [];
  let next = 0;
  const take = (): number => {
    const value = draws[next];
    if (value === undefined) throw new Error("the scripted fill has no draw left");
    next += 1;
    return value;
  };
  return {
    asked,
    fill(array) {
      asked.push({ kind: array instanceof Uint32Array ? "uint32" : "uint8", length: array.length });
      for (let index = 0; index < array.length; index += 1) {
        array[index] = array instanceof Uint32Array ? take() : take() & 0xff;
      }
    },
  };
}

/** The draw that gives code `code`: the code itself, below the top range. */
export function drawFor(code: string): number {
  return Number(code);
}

// ---- ids -------------------------------------------------------------------------------------------------------------

/** Ids as a fixture names them, the same for every key. */
export function fixedIds(codeId: string, emailRowId: string): ProofCodeIds {
  return { codeId: () => Promise.resolve(codeId), emailRowId: () => Promise.resolve(emailRowId) };
}

// ---- K-04 reads --------------------------------------------------------------------------------------------------

/** One handle on file: K-04 handles, with whose it is (person_handles) and, for a mobile, its chat. */
export interface HandleOnFile {
  readonly id: string;
  readonly kind: "phone" | "email";
  readonly address: string;
  readonly personId: string;
  readonly chatOpen?: boolean;
}

/** Sam's email and mobile (K-09 v1 proof-code-email.json and proof-code-text-from-mobile.json). */
export const SAM_EMAIL: HandleOnFile = {
  id: "handle-sam-email",
  kind: "email",
  address: "sam@example.com",
  personId: "person-sam",
};
export const SAM_MOBILE: HandleOnFile = {
  id: "handle-sam",
  kind: "phone",
  address: "+15555550111",
  personId: "person-sam",
  chatOpen: false,
};
/** Jordan's mobile, never texted in (K-22 v1 seed-proof-code.json's Jordan; the 555-01xx range). */
export const JORDAN_MOBILE: HandleOnFile = {
  id: "handle-jordan",
  kind: "phone",
  address: "+15555550112",
  personId: "person-jordan",
  chatOpen: false,
};

/** T-307's reads over these handles, each mobile with its chat open or not; the reads a code never makes refuse. */
export function readerOver(handles: readonly HandleOnFile[]): MessagesReader {
  const refuse = (): Promise<never> => Promise.reject(new Error("a proof code makes no such read"));
  return {
    person: refuse,
    handleIdsOfPerson: (personId) =>
      Promise.resolve(handles.filter((each) => each.personId === personId).map((each) => each.id)),
    handle: (handleId) => {
      const found = handles.find((each) => each.id === handleId);
      return Promise.resolve(
        found === undefined ? null : { id: found.id, kind: found.kind, address: found.address },
      );
    },
    phoneOfHandle: (handleId) => {
      const found = handles.find((each) => each.id === handleId && each.kind === "phone");
      const open = found?.chatOpen === true;
      return Promise.resolve(
        found === undefined
          ? null
          : {
              number: found.address,
              handleId: found.id,
              chatOpen: open,
              chatOpenAt: open ? new Date("2026-10-20T07:40:00Z") : null,
              chatWay: open ? "imessage" : null,
              stopped: false,
              stopAt: null,
              startAt: null,
              linqContactAddedAt: null,
              pollVotedAt: null,
              optoutLineDeliveredAt: null,
              version: 1,
            },
      );
    },
    chatThreadOf: refuse,
    consentsOfPersons: refuse,
  };
}

// ---- K-22 v1 proof_codes -----------------------------------------------------------------------------------------

const MINUTE = 60_000;

const at = (utc: string): number => Date.parse(utc);
const utc = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/u, "Z");

/** A row of the double's proof_codes, its hash included. */
interface StoredRow extends CodeState {
  readonly codeHash: string;
  readonly hashKeyName: string;
}

/** A CHECK of K-22 v1 a send's row broke (SQLSTATE 23514): the double writes nothing. */
export class K22CheckError extends Error {
  override name = "K22CheckError";
}

/** The double of K-22 v1's codes, with what each call was given. */
export class K22Double implements ProofCodeStore {
  readonly rows = new Map<string, StoredRow>();
  /** Each send written, in order. */
  readonly sends: CodeSend[] = [];
  /** Each check's entries, in order. */
  readonly checkEvents: EventEntry[] = [];
  /** How many times check_proof_code ran. */
  checkCalls = 0;
  private readonly sent = new Map<string, SentCode>();
  private readonly checked = new Map<string, { codeId: string; result: CheckResult }>();

  sentFor(key: string): Promise<SentCode | null> {
    return Promise.resolve(this.sent.get(key) ?? null);
  }

  /** K-22 v1 proof_code_limits (0020 lines 777 to 797). */
  limits(ask: LimitsAsk): Promise<CodeLimits> {
    const mine = [...this.rows.values()].filter((row) => row.sentToHandleId === ask.handleId);
    const sentSince = mine.filter((row) => at(row.sentAt) >= at(ask.since)).length;
    const pauses = mine
      .filter(
        (row) => row.purpose === ask.purpose && row.pausedUntil !== null && at(row.pausedUntil) > at(ask.at),
      )
      .map((row) => at(row.pausedUntil ?? ""));
    return Promise.resolve({ sentSince, pausedUntil: pauses.length === 0 ? null : utc(Math.max(...pauses)) });
  }

  /** The send's one transaction: the code row under K-22 v1's CHECKs, unique on its key and its id. */
  commitSend(send: CodeSend): Promise<SendCommitAnswer> {
    const first = this.sent.get(send.key);
    if (first !== undefined) return Promise.resolve({ committed: true, repeated: true, first });
    const { code } = send;
    if (!/^[0-9a-f]{64}$/u.test(code.code_hash)) throw new K22CheckError("proof_codes_hash_form");
    if (!/^[A-Z][A-Z0-9_]*$/u.test(code.hash_key_name)) throw new K22CheckError("proof_codes_key_name_form");
    if (at(code.expires_at) !== at(code.sent_at) + 10 * MINUTE)
      throw new K22CheckError("proof_codes_ten_minutes");
    if (code.person_id === null && code.purpose !== "listing_control")
      throw new K22CheckError("proof_codes_who");
    if (this.rows.has(code.id)) throw new K22CheckError("proof_codes_pkey");
    this.rows.set(code.id, {
      id: code.id,
      purpose: code.purpose,
      personId: code.person_id,
      businessId: code.business_id,
      sentToHandleId: code.sent_to_handle_id,
      channel: code.channel,
      sentAt: code.sent_at,
      expiresAt: code.expires_at,
      wrongTries: 0,
      lastWrongAt: null,
      pausedUntil: null,
      usedAt: null,
      version: 1,
      codeHash: code.code_hash,
      hashKeyName: code.hash_key_name,
    });
    const written: SentCode = {
      proofCodeId: code.id,
      expiresAt: code.expires_at,
      outboxRowId: send.email === null ? null : send.email.row.id,
    };
    this.sent.set(send.key, written);
    this.sends.push(send);
    return Promise.resolve({ committed: true, repeated: false, first: written });
  }

  /** The row without its hash. */
  code(codeId: string): Promise<CodeState | null> {
    const row = this.rows.get(codeId);
    return Promise.resolve(row === undefined ? null : stateOf(row));
  }

  checkedFor(key: string, codeId: string): Promise<CheckResult | null> {
    const first = this.checked.get(key);
    return Promise.resolve(first?.codeId === codeId ? first.result : null);
  }

  /** K-22 v1 check_proof_code (0020 lines 728 to 770), keyed. */
  check(ask: CheckAsk): Promise<CheckResult> {
    this.checkCalls += 1;
    const first = this.checked.get(ask.key);
    if (first?.codeId === ask.codeId) return Promise.resolve({ ...first.result, repeated: true });
    const result = this.checkOnce(ask);
    this.checked.set(ask.key, { codeId: ask.codeId, result });
    return Promise.resolve(result);
  }

  logCheck(_key: string, events: readonly EventEntry[]): Promise<void> {
    this.checkEvents.push(...events);
    return Promise.resolve();
  }

  private checkOnce(ask: CheckAsk): CheckResult {
    const row = this.rows.get(ask.codeId);
    if (row === undefined) return { outcome: "unknown", code: null, repeated: false };
    const answer = (outcome: CheckResult["outcome"], next: StoredRow = row): CheckResult => {
      this.rows.set(next.id, next);
      return { outcome, code: stateOf(next), repeated: false };
    };
    if (row.usedAt !== null) return answer("used");
    if (row.pausedUntil !== null) return answer("paused");
    if (at(ask.at) < at(row.sentAt) || at(ask.at) > at(row.expiresAt)) return answer("expired");
    if (row.codeHash === ask.typedHash)
      return answer("right", { ...row, usedAt: ask.at, version: row.version + 1 });
    const wrongTries = row.wrongTries + 1;
    const wrong: StoredRow = { ...row, wrongTries, lastWrongAt: ask.at, version: row.version + 1 };
    if (wrongTries === 5) return answer("paused", { ...wrong, pausedUntil: utc(at(ask.at) + 15 * MINUTE) });
    return answer("wrong", wrong);
  }
}

function stateOf(row: StoredRow): CodeState {
  return {
    id: row.id,
    purpose: row.purpose,
    personId: row.personId,
    businessId: row.businessId,
    sentToHandleId: row.sentToHandleId,
    channel: row.channel,
    sentAt: row.sentAt,
    expiresAt: row.expiresAt,
    wrongTries: row.wrongTries,
    lastWrongAt: row.lastWrongAt,
    pausedUntil: row.pausedUntil,
    usedAt: row.usedAt,
    version: row.version,
  };
}
