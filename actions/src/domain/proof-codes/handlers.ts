// The proof-code calls as the Tool API base runs them (T-322; C-095): sendProofCode and proveCode (K-09 v1), each made
// alone under the call's business scope, its request and answer held to K-09's schema by the base (T-290), its span
// recorded by the base with labels and row ids only. Every port defaults to the Worker's, or to failing closed until
// its task lands: no data-access calls for codes yet (ports.ts notBuiltStore) and no hashing port until the composition
// root binds one over PROOF_CODE_HASH_KEY (ADR-016 card D), so by default both calls answer notBuilt and write nothing.

import type { Handler } from "../../tool-api";
import { databaseOf } from "../flags";
import { messagesReaderOf, type MessagesReader } from "../messages-consent";
import { proveCode } from "./check";
import { WEB_CRYPTO_FILL, type RandomFill } from "./draw";
import type { KeyedHash } from "./hashing";
import { KEYED_CODE_IDS, notBuiltStore, type ProofCodeIds, type ProofCodeStore } from "./ports";
import { sendProofCode } from "./send";

/** What the proof-code calls run with; each port defaults to the Worker's, or to failing closed. */
export interface ProofCodeDeps<Repo> {
  /** K-22's codes through the data-access calls on the call's transaction. Default: none built (notBuilt). */
  readonly store?: (repo: Repo) => ProofCodeStore;
  /** T-307's K-04 reads. Default: the data-access calls on the call's database repo. */
  readonly reader?: (repo: Repo) => MessagesReader;
  /** The root's hashing port over the code-hash secret. Default: none, so no code is sent or checked (notBuilt). */
  readonly hash?: KeyedHash | null;
  /** The generator a code is drawn from. Default: Web Crypto's crypto.getRandomValues. */
  readonly random?: RandomFill;
  readonly ids?: ProofCodeIds;
  /** The call's now, UTC ending in Z. Default: the clock, to the whole second. */
  readonly now?: () => string;
}

const clockNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

/** sendProofCode as the Tool API base's handler. */
export function sendProofCodeHandler<Repo>(deps: ProofCodeDeps<Repo> = {}): Handler<"sendProofCode", Repo> {
  return async (request, context) => {
    const outcome = await sendProofCode(request, (deps.now ?? clockNow)(), {
      store: deps.store === undefined ? notBuiltStore("sendProofCode") : deps.store(context.repo),
      reader: () =>
        deps.reader === undefined ? messagesReaderOf(databaseOf(context.repo)) : deps.reader(context.repo),
      hash: deps.hash ?? null,
      random: deps.random ?? WEB_CRYPTO_FILL,
      ids: deps.ids ?? KEYED_CODE_IDS,
    });
    context.span.rows.push(...outcome.wrote.map((row) => ({ table: row.table, id: row.id })));
    return outcome.answer;
  };
}

/** proveCode as the Tool API base's handler. */
export function proveCodeHandler<Repo>(deps: ProofCodeDeps<Repo> = {}): Handler<"proveCode", Repo> {
  return async (request, context) => {
    const outcome = await proveCode(request, {
      store: deps.store === undefined ? notBuiltStore("proveCode") : deps.store(context.repo),
      hash: deps.hash ?? null,
    });
    if (outcome.touched !== null) context.span.rows.push({ ...outcome.touched });
    return outcome.answer;
  };
}
