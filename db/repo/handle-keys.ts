// Data-access v1.2: get or create a handle's sealing key, the gateway's call (K-05 v1.2 item 29; QUESTIONS.md NQ-RT-1;
// NQ-DB-1; arch 02 line 109; arch 01 line 93; RULES 4.10; T-220).
//
// The gateway seals each inbound event under the key of the handle that wrote it before anything stores it (T-243,
// T-553). On K-04 v1 as frozen a key is a person's (sealing_keys by person_id), so a handle's key is a key of one of
// its people ("made on first sight of the handle and linked to the person once known": NQ-RT-1's default, through
// person_handles). In one transaction, under a transaction-level advisory lock keyed on the handle's address (as
// reserve() locks an agent token), so parallel first sights of one number make one handle, one person and one key:
//   1. the handle by its address (handles_address_key), else written with newHandleId;
//   2. the oldest held key among the handle's people (sealing_keys.created_at, a tie to the lower person id): found,
//      nothing is written;
//   3. else the first of its people with no key at all (the lower person id) gets a key now;
//   4. else, at first sight or when every person on the handle has had their key erased (RULES 4.10: the row stays,
//      wrapped_key null), a person with no name yet (persons.name "null until known") is written with newPersonId,
//      linked to the handle, and given a key: so the number's next text, a stop in other words, START, HELP or a
//      danger text included, is still sealed and reaches a turn (K-05 open gap 18, closed). The erased keys stay
//      erased; nothing of theirs is unsealed, and the call removes nothing (the erased person keeps their link: open
//      gap 28, C-156's).
// A key made here is a random 256-bit AES-GCM data key, stored only wrapped under the Workers secret the request names
// (NQ-DB-1's default: one environment key wraps every data key), in db/repo/sealing.ts's form (T-182): format byte
// 0x01, a 12-byte IV, then the AES-GCM body with its tag, additional data "rosie:wrap:v1:" + the person id. So
// sealing.ts's seal() and unseal() use the same key, and erasePerson() erases it. The form is repeated here because
// sealing.ts keeps its helpers to itself and is outside this task's files.
//
// The key never appears in the answer (K-05 rule 7; refuse-handle-key-with-key-value): the request names the secret,
// never its value, which the caller's resolver reads from the environment; the answer says what K-04's row says (the
// secret's name, when the key was made, its version), never its bytes, wrapped or not; and the data key is handed back
// beside the answer as a key object for AES-256-GCM that cannot be exported, for encrypt and decrypt only.
//
// Side (K-05 v1.2 README line 153): the runtime side, run by rosie_job with no business scope; every table it touches
// is scoped none (handles, persons, person_handles, sealing_keys). Reads and writes the primary, uncached, in one read
// committed transaction, so each read after the lock sees what an earlier holder of the lock committed. A new id that
// is already taken answers constraint (23505); a serialization failure, a deadlock or a lost connection answers
// transient; nothing is written on either, and the gateway answers 503 (arch 02 line 109). Nothing here logs: an
// error carries a code and a fixed message, never a key, an address or an id.
import { SealingError, type WrappingKeys } from "./sealing";
import type { Sql, Tx } from "./scope";
import {
  assertId,
  assertRequestShape,
  assertRuntimeSide,
  inRuntimeTransaction,
  type TransientError,
  transientOrThrow,
  utc,
} from "./targets";

type Db = Sql | Tx;

/** The handle as the inbound event names it (K-06 v1 handle; K-04 handles: E.164, or an email in lower case). */
export interface HandleRef {
  kind: "phone" | "email";
  address: string;
}

export interface HandleSealingKeyRequest {
  handle: HandleRef;
  /** The id a new handle row takes; unused when the handle exists. New on every call, never built from the address. */
  newHandleId: string;
  /** The id a new person takes (first sight, or every key on the handle erased); unused otherwise. New on every call. */
  newPersonId: string;
  /** The name of the Workers secret a new key is wrapped under: a name, never a value. */
  wrappingKeyName: string;
}

export interface HandleSealingKeyResponse {
  result: "key";
  handleId: string;
  /** The person whose key it is. */
  personId: string;
  /** What this call wrote: the handle row, the person row with its person_handles link, the key row. */
  created: { handle: boolean; person: boolean; key: boolean };
  /** K-04 sealing_keys as the row stands, never its bytes. */
  key: { wrappingKeyName: string; createdAt: string; version: number };
}

/** K-05's constraint error: a database rule refused a write; nothing was written. */
export interface ConstraintError {
  error: "constraint";
  sqlstate: string;
  constraint: string;
}

export type HandleSealingKeyOutcome = HandleSealingKeyResponse | ConstraintError | TransientError;

/**
 * The answer with the data key beside it, never inside it: the key object comes only with a key answer. It encrypts
 * and decrypts with AES-256-GCM and cannot be exported.
 */
export type HandleSealingKeyResult =
  | { outcome: HandleSealingKeyResponse; dataKey: CryptoKey }
  | { outcome: ConstraintError | TransientError; dataKey: null };

export interface HandleKeyOptions {
  /** When a new key is made (its created_at), for the test's fake clock. Default: the transaction's now(). */
  now?: Date;
}

/** Where the wrapping key's value comes from: the caller reads the Workers secret by name (sealing.ts's resolver). */
export type WrappingKeyResolver = Pick<WrappingKeys, "resolve">;

const FIELDS = ["handle", "newHandleId", "newPersonId", "wrappingKeyName"] as const;
const HANDLE_KINDS = new Set<string>(["phone", "email"]);
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const PHONE_ADDRESS = /^\+[1-9][0-9]{6,14}$/;
const SEAL_FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** The SQLSTATEs K-05 answers as constraint: EXCLUDE, CHECK, unique, foreign key (data-access.v1 constraintError). */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);

interface HeldKeyRow {
  person_id: string;
  wrapped_key: Uint8Array;
  wrapping_key_name: string;
  created_at: Date;
  version: number;
}

const encoder = new TextEncoder();
const subtle = (): SubtleCrypto => crypto.subtle;

function validate(request: HandleSealingKeyRequest): void {
  assertRequestShape(request, "handleSealingKey", FIELDS);
  assertRequestShape(request.handle, "handleSealingKey handle", ["kind", "address"]);
  const { kind, address } = request.handle;
  if (!HANDLE_KINDS.has(kind)) {
    throw new TypeError("handle.kind is phone or email");
  }
  if (
    typeof address !== "string" ||
    (kind === "phone" ? !PHONE_ADDRESS.test(address) : !address.includes("@"))
  ) {
    throw new TypeError("handle.address is an E.164 number or an email address");
  }
  assertId(request.newHandleId, "newHandleId");
  assertId(request.newPersonId, "newPersonId");
  if (typeof request.wrappingKeyName !== "string" || !SECRET_NAME.test(request.wrappingKeyName)) {
    throw new TypeError("wrappingKeyName is a secret's name such as SEALING_WRAP_KEY");
  }
}

function aad(personId: string): Uint8Array {
  return encoder.encode(`rosie:wrap:v1:${personId}`);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim());
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The wrapping key named `name`, as a key object that can wrap and unwrap and nothing else (sealing.ts's rule). */
async function importWrappingKey(keys: WrappingKeyResolver, name: string): Promise<CryptoKey> {
  const value = await keys.resolve(name);
  if (value === undefined || value === "") {
    throw new SealingError("wrapping_key_missing");
  }
  const bytes = typeof value === "string" ? fromBase64(value) : value;
  if (bytes?.length !== KEY_BYTES) {
    throw new SealingError("wrapping_key_invalid");
  }
  return subtle().importKey("raw", bytes, { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey"]);
}

async function wrapDataKey(
  wrappingKey: CryptoKey,
  dataKey: CryptoKey,
  personId: string,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(
    await subtle().wrapKey("raw", dataKey, wrappingKey, {
      name: "AES-GCM",
      iv,
      additionalData: aad(personId),
    }),
  );
  const wrapped = new Uint8Array(1 + IV_BYTES + body.length);
  wrapped[0] = SEAL_FORMAT_V1;
  wrapped.set(iv, 1);
  wrapped.set(body, 1 + IV_BYTES);
  return wrapped;
}

/** The data key as a key object that cannot be exported, for encrypt and decrypt only. */
async function unwrapDataKey(
  wrappingKey: CryptoKey,
  wrapped: Uint8Array,
  personId: string,
): Promise<CryptoKey> {
  if (wrapped.length <= 1 + IV_BYTES || wrapped[0] !== SEAL_FORMAT_V1) {
    throw new SealingError("bad_format");
  }
  try {
    return await subtle().unwrapKey(
      "raw",
      wrapped.slice(1 + IV_BYTES),
      wrappingKey,
      { name: "AES-GCM", iv: wrapped.slice(1, 1 + IV_BYTES), additionalData: aad(personId) },
      { name: "AES-GCM", length: KEY_BYTES * 8 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new SealingError("cannot_open");
  }
}

/** The oldest held key among the handle's people (created_at, a tie to the lower person id), or undefined. */
async function oldestHeldKey(db: Db, handleId: string): Promise<HeldKeyRow | undefined> {
  const [row] = await db<HeldKeyRow[]>`
    select k.person_id, k.wrapped_key, k.wrapping_key_name, k.created_at, k.version
    from person_handles ph
    join sealing_keys k on k.person_id = ph.person_id
    where ph.handle_id = ${handleId} and k.wrapped_key is not null
    order by k.created_at, k.person_id collate "C"
    limit 1
  `;
  return row;
}

/** The first of the handle's people with no key row at all (the lower person id), or undefined. */
async function firstPersonWithoutKey(db: Db, handleId: string): Promise<string | undefined> {
  const [row] = await db<{ person_id: string }[]>`
    select ph.person_id from person_handles ph
    where ph.handle_id = ${handleId}
      and not exists (select 1 from sealing_keys k where k.person_id = ph.person_id)
    order by ph.person_id collate "C"
    limit 1
  `;
  return row?.person_id;
}

const keyInfo = (row: { wrapping_key_name: string; created_at: Date; version: number }) => ({
  wrappingKeyName: row.wrapping_key_name,
  createdAt: utc(row.created_at),
  version: row.version,
});

/**
 * Gets or makes the handle's sealing key inside the transaction `db`, which must run on the runtime side (no business
 * scope) at read committed. Prefer handleSealingKey(); this is for a caller that already holds a transaction. A new id
 * already taken throws the database's error (23505).
 */
export async function handleSealingKeyIn(
  db: Db,
  keys: WrappingKeyResolver,
  request: HandleSealingKeyRequest,
  options: HandleKeyOptions = {},
): Promise<{ outcome: HandleSealingKeyResponse; dataKey: CryptoKey }> {
  validate(request);
  await assertRuntimeSide(db, "handleSealingKey");
  const { kind, address } = request.handle;
  const created = { handle: false, person: false, key: false };

  // Parallel first sights of one address run one after the other from here (K-05 item 29; default 28).
  await db`select pg_advisory_xact_lock(hashtextextended(${`handle:${address}`}, 0))`;

  let [handle] = await db<{ id: string }[]>`select id from handles where address = ${address}`;
  if (handle === undefined) {
    // A commit writing the same contact without this lock (a booking the business adds) may win the address: then
    // nothing is inserted here and its handle is read below. A new id that another handle holds is still refused.
    [handle] = await db<{ id: string }[]>`
      insert into handles (id, kind, address) values (${request.newHandleId}, ${kind}, ${address})
      on conflict (address) do nothing
      returning id
    `;
    created.handle = handle !== undefined;
    handle ??= (await db<{ id: string }[]>`select id from handles where address = ${address}`)[0];
    if (handle === undefined) {
      throw new Error("handleSealingKey: the handle could be neither written nor read");
    }
  }
  const handleId = handle.id;

  const held = await oldestHeldKey(db, handleId);
  if (held !== undefined) {
    const wrappingKey = await importWrappingKey(keys, held.wrapping_key_name);
    const dataKey = await unwrapDataKey(wrappingKey, new Uint8Array(held.wrapped_key), held.person_id);
    return {
      outcome: { result: "key", handleId, personId: held.person_id, created, key: keyInfo(held) },
      dataKey,
    };
  }

  // The wrapping key is read before anything more is written, so a missing secret writes nothing.
  const wrappingKey = await importWrappingKey(keys, request.wrappingKeyName);

  let personId = await firstPersonWithoutKey(db, handleId);
  if (personId === undefined) {
    // First sight, or every person on the handle has had their key erased: a person with no name yet, linked.
    personId = request.newPersonId;
    await db`insert into persons (id) values (${personId})`;
    await db`insert into person_handles (person_id, handle_id) values (${personId}, ${handleId})`;
    created.person = true;
  }

  const fresh = (await subtle().generateKey({ name: "AES-GCM", length: KEY_BYTES * 8 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const wrapped = await wrapDataKey(wrappingKey, fresh, personId);
  // sealing.ts's first seal of this person may have made a key meanwhile: then that key is the person's.
  const [made] = await db<{ wrapping_key_name: string; created_at: Date; version: number }[]>`
    insert into sealing_keys (person_id, wrapped_key, wrapping_key_name, created_at)
    values (${personId}, ${wrapped}, ${request.wrappingKeyName}, coalesce(${options.now ?? null}::timestamptz, now()))
    on conflict (person_id) do nothing
    returning wrapping_key_name, created_at, version
  `;
  if (made === undefined) {
    const [kept] = await db<HeldKeyRow[]>`
      select person_id, wrapped_key, wrapping_key_name, created_at, version from sealing_keys
      where person_id = ${personId} and wrapped_key is not null
    `;
    if (kept === undefined) {
      throw new SealingError("erased");
    }
    const keptWrapping = await importWrappingKey(keys, kept.wrapping_key_name);
    return {
      outcome: { result: "key", handleId, personId, created, key: keyInfo(kept) },
      dataKey: await unwrapDataKey(keptWrapping, new Uint8Array(kept.wrapped_key), personId),
    };
  }
  created.key = true;
  // The key handed back is the stored one, unwrapped again: it cannot be exported, and the round trip proves the row.
  const dataKey = await unwrapDataKey(wrappingKey, wrapped, personId);
  return { outcome: { result: "key", handleId, personId, created, key: keyInfo(made) }, dataKey };
}

/**
 * Gets or makes a handle's sealing key (K-05 v1.2 item 29), for the gateway: one transaction on the primary, uncached,
 * on the runtime side. Pass the client's primary handle, run as rosie_job, and a resolver that reads the Workers secret
 * by name. The answer never holds the key; the data key comes beside it. constraint when a new id is already taken;
 * transient on a serialization failure, a deadlock or a lost connection. A missing or malformed wrapping key throws
 * SealingError, and nothing is written.
 */
export async function handleSealingKey(
  sql: Sql,
  keys: WrappingKeyResolver,
  request: HandleSealingKeyRequest,
  options: HandleKeyOptions = {},
): Promise<HandleSealingKeyResult> {
  validate(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) =>
      handleSealingKeyIn(tx, keys, request, options),
    );
  } catch (error) {
    const failure = error as { code?: unknown; constraint_name?: unknown } | null;
    if (
      typeof failure?.code === "string" &&
      CONSTRAINT_SQLSTATES.has(failure.code) &&
      typeof failure.constraint_name === "string"
    ) {
      return {
        outcome: { error: "constraint", sqlstate: failure.code, constraint: failure.constraint_name },
        dataKey: null,
      };
    }
    return { outcome: transientOrThrow(error), dataKey: null };
  }
}
