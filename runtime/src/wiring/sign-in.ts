// The sign-in page calls on the Worker (ADR-016 card D, sections 2, 4 and 6; T-1289; C-193; K-21 v1 signInStart,
// signInCheck and signOut; K-05 v1.13 items 58 to 63): T-1282's and T-1285's handlers (@rosie/actions,
// actions/src/page-calls/sign-in) over the ports the root holds, for the gateway's page entry (GatewayDeps.pages, T-266).
// The root binds them where ENVIRONMENT is staging and it is handed their inputs (RootOptions.signIn: staging's are
// ./staging/sign-in.ts); everywhere else each of the three calls stays unconfigured (503). Production's binding waits for
// journey 1's flag and a per-client edge limit (ADR-016 open points 9 and 13).
//
// One call, in this order:
//   1. signInStart and signInCheck ask the inputs for the hashing port (HMAC-SHA-256 under PROOF_CODE_HASH_KEY, the key
//      read by name at this call); with none, the handler answers 503 before any port, writing and counting nothing
//      (T-1282's and T-1285's noHashKey). signOut needs no key and reads none;
//   2. the handler runs over its ports as T-1282 and T-1285 built it, and gives the page its answer; every time it reads
//      or writes is the database's own (K-05 default 112: no request carries a time, so no page value sets one);
//   3. what the handler hands on to run after its answer (`later`): the code's send and then ADR-016 section 2's dispatch
//      (signInStart), or the check's or the sign-out's entries. It starts a turn of the event loop after the handler's,
//      so never before the answer and never awaited by it, inside the request's waitUntil, which the page entry hands
//      on (PageRequest.waitUntil): it runs to its end after the answer has gone. A call with no waitUntil (no execution
//      context) runs it all the same, with nothing keeping it alive.
//
// The dispatch after the code's commit (ADR-016 section 2): once sendSignInCode answers that the code's email row is
// written (sent), or was by an earlier send of the same attempt (repeated), the row's recipient handle is read by the
// row's id (`recipientOf`: K-05 sendState's recipient), and the root's own dispatcher runs once for that recipient
// (`wake`, as a turn's wake makes it), on the page call's trace, which the row carries. A send that wrote nothing
// (notSent, failed) wakes nothing. A recipient that cannot be read, or a run that fails, leaves the row checked until its
// recipient's next wake, which withdraws it unsent at its notAfter (ADR-016 section 2 and open point 6); one JSON line
// says which, in labels alone.
//
// Nothing here writes a span: the handlers write theirs on the call's trace and the dispatcher its own. Never logged or
// put in an error: a code, a token, a contact, an address, a hash, the key or an id.

import {
  signInCheckHandler,
  signInStartHandler,
  signOutHandler,
  type SendReport,
  type SignInAfterCheckStore,
  type SignInCheckStore,
  type SignInSendStore,
} from "@rosie/actions/src/page-calls/sign-in/index";
import type { KeyedHash } from "@rosie/actions/src/domain/proof-codes/index";

import type { PageHandlers, PageRequest } from "../gateway/pages";
import { isLabel, type LogContext, type TraceContext } from "../trace";

/**
 * What the root is handed for the sign-in calls (RootOptions.signIn): K-05 v1.13's six calls, each with its database bound
 * on the side ADR-016 section 6 names, the hashing port, and the read of a row's recipient for the dispatch.
 */
export interface SignInInputs {
  /** startSignIn and sendSignInCode, on the runtime side's client (items 58 and 59). */
  readonly send: SignInSendStore;
  /** proveSignIn and endSession, on the Tool API's client (items 60 and 61). */
  readonly check: SignInCheckStore;
  /** personStanding and signInEntries, on the runtime side's client (items 62 and 63). */
  readonly afterCheck: SignInAfterCheckStore;
  /**
   * The hashing port over PROOF_CODE_HASH_KEY, the key read by name at this call (the call's trace id names the line a
   * missing key writes); null when it cannot be read, so the call answers 503 and nothing is written or counted.
   */
  readonly hash: (traceId: string) => Promise<KeyedHash | null>;
  /**
   * The recipient handle of the outbox row with this id (K-05 sendState's recipient, on the runtime side), or null when
   * K-05 names no row now (notFound, transient). A throw: the read could not be made.
   */
  readonly recipientOf: (outboxRowId: string, traceId: string) => Promise<string | null>;
}

/** What the three calls reach besides their inputs: the root's dispatcher, and where its one line goes. */
export interface SignInPageDeps {
  readonly inputs: SignInInputs;
  /**
   * One claim-and-send run of the root's dispatcher for one recipient, its code row on the page call's trace (the root's
   * sign-in wake). It may reject: that is logged, never thrown on.
   */
  readonly wake: (recipientHandleId: string, trace: TraceContext) => Promise<void>;
  /** ENVIRONMENT and GIT_SHA, beside every line written here (ADR-009). */
  readonly log: LogContext;
  /** Where each line goes. Left out: console.log (Workers Logs). */
  readonly write?: (line: string) => void;
}

/** Where the dispatch after the code's commit stopped, and so sent nothing now. */
export type SignInWakeStage = "recipientRead" | "noRecipient" | "dispatch" | "afterAnswer";

/** The one line a dispatch that sent nothing writes: the call's trace, the stage, an error's name; labels alone. */
export interface SignInWakeLine {
  readonly level: "warn";
  readonly msg: "signInWakeFailed";
  readonly trace_id: string;
  readonly stage: SignInWakeStage;
  readonly error: string | null;
  readonly environment: string;
  readonly version: string;
}

/** A thrown error by its name, only when that name is a label (its message could carry a value); else "error". */
const labelOf = (error: unknown): string =>
  error instanceof Error && isLabel(error.name) ? error.name : "error";

/** A turn of the event loop: the handler's answer, and the page entry's with it, are made before it ends. */
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** signInStart, signInCheck and signOut over the inputs, for {...unconfiguredPages(), ...} on staging. */
export function signInPages(
  deps: SignInPageDeps,
): Pick<PageHandlers, "signInStart" | "signInCheck" | "signOut"> {
  const { inputs } = deps;
  const write =
    deps.write ??
    ((line: string) => {
      console.log(line);
    });
  const failed = (page: PageRequest, stage: SignInWakeStage, error: unknown): void => {
    const line: SignInWakeLine = {
      level: "warn",
      msg: "signInWakeFailed",
      trace_id: page.trace.traceId,
      stage,
      error: error === null ? null : labelOf(error),
      environment: deps.log.environment,
      version: deps.log.version,
    };
    write(JSON.stringify(line));
  };

  /**
   * Runs `work` once the answer has gone: a turn after the handler's, in the request's waitUntil when the page entry
   * handed one on. The work's own failures are its own to report; anything it still throws is written as one line.
   */
  const afterAnswer = (page: PageRequest, work: () => Promise<unknown>): void => {
    const running = nextTurn()
      .then(work)
      .then(
        () => undefined,
        (error: unknown) => {
          failed(page, "afterAnswer", error);
        },
      );
    if (page.waitUntil === undefined) {
      void running;
      return;
    }
    page.waitUntil(running);
  };

  /** ADR-016 section 2: one dispatch for the written code row's recipient, on the page call's trace. Never rejects. */
  const wakeFor = async (report: SendReport, page: PageRequest): Promise<void> => {
    if (report.result !== "sent" && report.result !== "repeated") return;
    let recipient: string | null;
    try {
      recipient = await inputs.recipientOf(report.outboxRowId, page.trace.traceId);
    } catch (error) {
      failed(page, "recipientRead", error);
      return;
    }
    if (recipient === null) {
      failed(page, "noRecipient", null);
      return;
    }
    try {
      await deps.wake(recipient, page.trace);
    } catch (error) {
      failed(page, "dispatch", error);
    }
  };

  return {
    async signInStart(page) {
      const hash = await inputs.hash(page.trace.traceId);
      return signInStartHandler(page, {
        store: inputs.send,
        hash,
        later: (work, handed) => {
          afterAnswer(handed, async () => {
            await wakeFor(await work(), handed);
          });
        },
      });
    },
    async signInCheck(page) {
      const hash = await inputs.hash(page.trace.traceId);
      return signInCheckHandler(page, {
        check: inputs.check,
        afterCheck: inputs.afterCheck,
        hash,
        later: (work, handed) => {
          afterAnswer(handed, work);
        },
      });
    },
    signOut(page) {
      return signOutHandler(page, {
        check: inputs.check,
        afterCheck: inputs.afterCheck,
        later: (work, handed) => {
          afterAnswer(handed, work);
        },
      });
    },
  };
}
