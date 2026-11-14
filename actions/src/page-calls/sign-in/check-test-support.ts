// Test values for signInCheck's and signOut's server side (T-1285): K-21 v1's check and sign-out fixtures, and a double
// of K-05 v1.13's check side (proveSignIn, endSession) and its calls after the check (personStanding, signInEntries),
// over the same attempts as T-1282's double of the send side, so a start, its code's send, the checks and the next
// start meet one record, as they meet one database.
//
// The double is written from K-05 v1.13 items 60 to 63 and K-22 v1.2 rule 9 as they stand (migration 0034's
// sign_in_attempt and sign_in_attempt_tried, 0020's check_proof_code and session_for_token, line by line: the binding,
// the look, the attempt's own state, the code, then one wrong try of the attempt for any code that is not right), by the
// double's own clock, with the contract's numbers (5 tries, a 15-minute pause, 10 minutes, 30 days), never from the code
// under test, which counts nothing itself. Values come only from the fixtures (the master's sample cast, the reserved
// .example domain and placeholders: rule 9); the hashing key is T-322's fixed test pattern, not a secret. Not imported by
// any shipped module.

import type { RandomFill } from "../../domain/proof-codes";
import { nodeCodeHash, testHash } from "../../domain/proof-codes/test-support";
import type { KeyedHash } from "../../domain/proof-codes";
import {
  SAM_PERSON,
  SAM_TYPED,
  SignInDouble,
  k21Fixture,
  nodeSha256,
  testFill,
  type DoubleAttempt,
  type Exchange,
  type TestFill,
} from "./test-support";
import type {
  AfterAnswer,
  EndSessionOutcome,
  EndSessionRequest,
  EntriesAfterAnswer,
  PersonStandingOutcome,
  PersonStandingRequest,
  ProveSignInOutcome,
  ProveSignInRequest,
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInAfterCheckStore,
  SignInCheckDeps,
  SignInCheckStore,
  SignInEntriesOutcome,
  SignInEntriesRequest,
  SignInHandlerDeps,
} from "./types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** RULES 6.2: five wrong codes pause it 15 minutes; a code and an attempt work 10 minutes. */
const TRIES = 5;
const PAUSE = 15 * MINUTE;
const CODE_LIFE = 10 * MINUTE;
/** ADR-016 open point 2's default: a session lasts 30 days. */
const SESSION_LIFE = 30 * DAY;

const utc = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/u, "Z");

// ---- the fixtures ---------------------------------------------------------------------------------------------------

/** Sam's first session, the text way's check (K-21 v1 sign-in-done.json). */
export const SIGN_IN_DONE: Exchange = k21Fixture("sign-in-done.json");
/** The fifth wrong code of an attempt at Sam's email (K-21 v1 sign-in-wrong-five.json). */
export const SIGN_IN_WRONG_FIVE: Exchange = k21Fixture("sign-in-wrong-five.json");
/** A later check of Sam's signed-in attempt (K-21 v1 sign-in-already-signed-in.json). */
export const SIGN_IN_ALREADY: Exchange = k21Fixture("sign-in-already-signed-in.json");
/** Sam signs out of sign-in-done.json's session (K-21 v1 sign-out.json). */
export const SIGN_OUT: Exchange = k21Fixture("sign-out.json");

/** S11-52's example code; the 32-bit draw that gives it (below the top range, so taken at once). */
export const CODE = "482913";
export const CODE_DRAW = 482913;
/** A code that is not Sam's (the one sign-in-wrong-five.json types). */
export const WRONG_CODE = "111111";

/** A device token of another browser: a placeholder, as the fixtures' are. */
export const OTHER_DEVICE = "placeholder-device-token-other-1";

/** A check's request as the page sends it: sign-in-wrong-five.json's, with the fields given replaced. */
export function checkRequest(
  changes: {
    readonly attemptId?: string;
    readonly code?: string | null;
    readonly requestId?: string;
    readonly deviceToken?: string;
    readonly sessionToken?: string | null;
  } = {},
): Record<string, unknown> {
  const fixture = SIGN_IN_WRONG_FIVE.request as {
    page: Record<string, unknown>;
    attemptId: string;
    code: string;
    deviceToken: string;
  };
  return {
    page: {
      ...fixture.page,
      requestId: changes.requestId ?? fixture.page.requestId,
      sessionToken: changes.sessionToken === undefined ? fixture.page.sessionToken : changes.sessionToken,
    },
    attemptId: changes.attemptId ?? fixture.attemptId,
    code: changes.code === undefined ? fixture.code : changes.code,
    deviceToken: changes.deviceToken ?? fixture.deviceToken,
  };
}

/** A sign-out's request as the page sends it: sign-out.json's, with the fields given replaced. */
export function signOutRequest(
  changes: { readonly sessionToken?: string; readonly requestId?: string } = {},
): Record<string, unknown> {
  const fixture = SIGN_OUT.request as { page: Record<string, unknown> };
  return {
    page: {
      ...fixture.page,
      sessionToken: changes.sessionToken ?? fixture.page.sessionToken,
      requestId: changes.requestId ?? fixture.page.requestId,
    },
  };
}

// ---- K-05 v1.13's check side, as a double -----------------------------------------------------------------------

/** One K-22 proof_codes row of the double: the columns check_proof_code reads, its hash included. */
export interface DoubleCode {
  readonly id: string;
  readonly codeHash: string;
  readonly personId: string;
  readonly sentAt: number;
  readonly expiresAt: number;
  wrongTries: number;
  lastWrongAt: number | null;
  pausedUntil: number | null;
  usedAt: number | null;
}

/** An attempt's check columns (K-22 v1.2 sign_in_attempts), beside the start's that T-1282's double keeps. */
export interface DoubleCheckState {
  ownerOrAdmin: boolean;
  wrongTries: number;
  lastWrongAt: number | null;
  lastCheckKey: string | null;
  lastOutcome: string | null;
  sessionId: string | null;
}

/** One K-22 sessions row of the double. */
export interface DoubleSession {
  readonly id: string;
  readonly personId: string;
  readonly tokenSha256: string;
  readonly deviceSha256: string;
  readonly proofCodeId: string | null;
  readonly startedAt: number;
  readonly expiresAt: number;
  endedAt: number | null;
  endedWhy: string | null;
}

type CodeAnswer = "right" | "used" | "wrong" | "paused" | "expired" | "unknown";
type CheckAnswer = Exclude<ProveSignInOutcome, { error: string }>;

/**
 * K-05 v1.13 proveSignIn, endSession, personStanding and signInEntries over in-memory rows, beside T-1282's startSignIn
 * and sendSignInCode, by the one clock (`now`). Records each request and, in `calls`, the order calls reached it.
 */
export class SignInCheckDouble extends SignInDouble implements SignInCheckStore, SignInAfterCheckStore {
  /** The proof codes, by id: those sendSignInCode wrote and those a test seeded. */
  readonly codes = new Map<string, DoubleCode>();
  /** Each attempt's check columns, by the attempt's server id. */
  readonly checkStates = new Map<string, DoubleCheckState>();
  /** The sessions, by id. */
  readonly sessions = new Map<string, DoubleSession>();
  /** The standing personStanding reads for a person, by person id (none: no role, no team row). */
  readonly standings = new Map<string, { roles: { role: string; businessId: string }[]; team: boolean }>();
  /** The entries written, by id: their kind. */
  readonly log = new Map<string, string>();
  /**
   * Attempts whose code a turn proved by text (sign-in-done.json's story: K-21's text way, which K-05 v1.13 does not
   * serve, CQ-244): the next check of one uses its code as a right code would, whatever was typed.
   */
  readonly provenByText = new Set<string>();
  readonly proves: ProveSignInRequest[] = [];
  readonly ends: EndSessionRequest[] = [];
  readonly standingAsks: PersonStandingRequest[] = [];
  readonly entryAsks: SignInEntriesRequest[] = [];
  /** Each check-side answer the double gave, in order. */
  readonly checkAnswers: (
    ProveSignInOutcome | EndSessionOutcome | PersonStandingOutcome | SignInEntriesOutcome
  )[] = [];
  /** Answers, or faults to throw, for the next standing reads, in place of the rows'. */
  readonly scriptedStandings: (PersonStandingOutcome | Error)[] = [];
  /** Answers, or faults to throw, for the next entries calls, in place of the rows' (nothing is written for them). */
  readonly scriptedEntries: (SignInEntriesOutcome | Error)[] = [];
  /** An answer for the next check, in place of the rows' (nothing is read or written for it). */
  readonly scriptedChecks: ProveSignInOutcome[] = [];

  private gave<
    T extends ProveSignInOutcome | EndSessionOutcome | PersonStandingOutcome | SignInEntriesOutcome,
  >(answer: T): Promise<T> {
    this.checkAnswers.push(structuredClone(answer));
    return Promise.resolve(answer);
  }

  /** The attempt's check columns, as a new attempt has them until a check writes them. */
  stateOf(attempt: DoubleAttempt): DoubleCheckState {
    let state = this.checkStates.get(attempt.id);
    if (state === undefined) {
      state = {
        ownerOrAdmin: false,
        wrongTries: 0,
        lastWrongAt: null,
        lastCheckKey: null,
        lastOutcome: null,
        sessionId: null,
      };
      this.checkStates.set(attempt.id, state);
    }
    return state;
  }

  /** The attempt with this page attempt id, as a test reads it. */
  attemptOf(attemptId: string): DoubleAttempt {
    const attempt = this.attempts.find((each) => each.attemptId === attemptId);
    if (attempt === undefined) throw new Error("no such attempt in the double");
    return attempt;
  }

  /** Gives an attempt its code, sent `sentAt` (its start's time by default), with `code`'s keyed hash. */
  seedCode(attempt: DoubleAttempt, id: string, code: string, sentAt = attempt.startedAt): DoubleCode {
    if (attempt.personId === null) throw new Error("a code is made for a person");
    const row: DoubleCode = {
      id,
      codeHash: nodeCodeHash(code),
      personId: attempt.personId,
      sentAt,
      expiresAt: sentAt + CODE_LIFE,
      wrongTries: 0,
      lastWrongAt: null,
      pausedUntil: null,
      usedAt: null,
    };
    this.codes.set(id, row);
    attempt.proofCodeId = id;
    attempt.codeExpiresAt = row.expiresAt;
    return row;
  }

  /** Seeds a session, as an earlier check or a sign-in on another device would have left it. */
  seedSession(
    session: Partial<DoubleSession> & Pick<DoubleSession, "id" | "personId" | "tokenSha256" | "deviceSha256">,
  ): DoubleSession {
    const row: DoubleSession = {
      proofCodeId: null,
      startedAt: this.now - DAY,
      expiresAt: this.now - DAY + SESSION_LIFE,
      endedAt: null,
      endedWhy: null,
      ...session,
    };
    this.sessions.set(row.id, row);
    return row;
  }

  /** The send side as T-1282's double has it, keeping the code's hash for its checks. */
  override async sendSignInCode(request: SendSignInCodeRequest): Promise<SendSignInCodeOutcome> {
    const outcome = await super.sendSignInCode(request);
    const attempt = this.attempts.find((each) => each.id === request.signInAttemptId);
    if (
      "result" in outcome &&
      outcome.result === "sent" &&
      !outcome.repeated &&
      attempt?.personId !== null &&
      attempt?.personId !== undefined
    ) {
      this.codes.set(outcome.proofCodeId, {
        id: outcome.proofCodeId,
        codeHash: request.code.codeHash,
        personId: attempt.personId,
        sentAt: this.now,
        expiresAt: this.now + CODE_LIFE,
        wrongTries: 0,
        lastWrongAt: null,
        pausedUntil: null,
        usedAt: null,
      });
    }
    return outcome;
  }

  // -- K-05 v1.13 item 60 ------------------------------------------------------------------------------------------

  proveSignIn(request: ProveSignInRequest): Promise<ProveSignInOutcome> {
    this.calls.push("proveSignIn");
    this.proves.push(structuredClone(request));
    const scripted = this.scriptedChecks.shift();
    if (scripted !== undefined) return this.gave(scripted);
    // Step 1: the binding, by the page's attempt id and the device's sha256 together.
    const attempt = this.attempts.find(
      (each) => each.attemptId === request.attemptId && each.deviceSha256 === request.deviceSha256,
    );
    if (attempt === undefined) return this.gave({ error: "attemptNotFound" });
    const state = this.stateOf(attempt);
    // Step 2: the check's key and the look; a repeat answers its first result.
    const key = nodeSha256(`${attempt.id}\n${request.deviceSha256}\n${request.requestId}`);
    if (state.lastCheckKey === key) return this.gave(this.fromAttempt(attempt, state, true));
    // Step 3: the attempt's own state, recorded, no try counted (0034's sign_in_attempt: expired is now after
    // expires_at; paused is paused_until after now).
    const label =
      state.sessionId !== null
        ? "alreadySignedIn"
        : attempt.pausedUntil !== null && attempt.pausedUntil > this.now
          ? "paused"
          : this.now > attempt.expiresAt
            ? "expired"
            : null;
    if (label !== null) {
      state.lastCheckKey = key;
      state.lastOutcome = label;
      return this.gave(this.fromAttempt(attempt, state, false));
    }
    // Step 4: the code (0020's check_proof_code), or the text way's turn's proof (sign-in-done.json).
    const answer = this.provenByText.has(attempt.id)
      ? this.usedByText(attempt)
      : this.checkCode(attempt, request.typedHash);
    // Step 5.
    if (answer === "right") return this.gave(this.rightCode(attempt, state, key, request));
    if (answer === "used") {
      state.lastCheckKey = key;
      state.lastOutcome = "secondProofNeeded";
      return this.gave(this.fromAttempt(attempt, state, false));
    }
    this.wrongTry(attempt, state, key);
    return this.gave(this.fromAttempt(attempt, state, false));
  }

  /** 0020's check_proof_code, line by line. */
  private checkCode(attempt: DoubleAttempt, typedHash: string): CodeAnswer {
    if (attempt.proofCodeId === null) return "unknown";
    const code = this.codes.get(attempt.proofCodeId);
    if (code === undefined) return "unknown";
    if (code.usedAt !== null) return "used";
    if (code.pausedUntil !== null) return "paused";
    if (this.now < code.sentAt || this.now > code.expiresAt) return "expired";
    if (code.codeHash === typedHash) {
      code.usedAt = this.now;
      return "right";
    }
    code.wrongTries += 1;
    code.lastWrongAt = this.now;
    if (code.wrongTries === TRIES) {
      code.pausedUntil = this.now + PAUSE;
      return "paused";
    }
    return "wrong";
  }

  /** The text way's turn proved the code: it is used now, and this check starts the session (sign-in-done.json). */
  private usedByText(attempt: DoubleAttempt): CodeAnswer {
    const code = attempt.proofCodeId === null ? undefined : this.codes.get(attempt.proofCodeId);
    if (code?.usedAt !== null) return "unknown";
    code.usedAt = this.now;
    return "right";
  }

  /** 0034's sign_in_attempt_tried with outcome wrong: one wrong try, or, past the tries or the time, nothing counted. */
  private wrongTry(attempt: DoubleAttempt, state: DoubleCheckState, key: string): void {
    state.lastCheckKey = key;
    if (state.wrongTries < TRIES && attempt.pausedUntil === null && this.now <= attempt.expiresAt) {
      state.wrongTries += 1;
      state.lastWrongAt = this.now;
      if (state.wrongTries === TRIES) attempt.pausedUntil = this.now + PAUSE;
      state.lastOutcome = state.wrongTries === TRIES ? "paused" : "wrong";
      return;
    }
    state.lastOutcome = attempt.pausedUntil !== null && attempt.pausedUntil > this.now ? "paused" : "expired";
  }

  /** Step 5's right code: the second proof, or the session under rule 5's insert (one per code, id and token hash). */
  private rightCode(
    attempt: DoubleAttempt,
    state: DoubleCheckState,
    key: string,
    request: ProveSignInRequest,
  ): ProveSignInOutcome {
    const { personId, proofCodeId } = attempt;
    if (personId === null || proofCodeId === null) throw new Error("a right code names a person and a code");
    const theirs = [...this.sessions.values()].filter((session) => session.personId === personId);
    const deviceKnown = theirs.some((session) => session.deviceSha256 === request.deviceSha256);
    if (state.ownerOrAdmin && !deviceKnown && theirs.length > 0) {
      state.lastCheckKey = key;
      state.lastOutcome = "secondProofNeeded";
      return {
        outcome: "secondProofNeeded",
        signInAttemptId: attempt.id,
        personId,
        proofCodeId,
        repeated: false,
      };
    }
    const taken = [...this.sessions.values()].some(
      (session) =>
        session.id === request.session.id ||
        session.tokenSha256 === request.session.tokenSha256 ||
        session.proofCodeId === proofCodeId,
    );
    if (taken) {
      // The whole check rolls back, the code's use included (K-05 item 60: constraint, nothing written).
      const code = this.codes.get(proofCodeId);
      if (code !== undefined) code.usedAt = null;
      return { error: "constraint", sqlstate: "23505", constraint: "sessions_pkey" };
    }
    this.sessions.set(request.session.id, {
      id: request.session.id,
      personId,
      tokenSha256: request.session.tokenSha256,
      deviceSha256: request.deviceSha256,
      proofCodeId,
      startedAt: this.now,
      expiresAt: this.now + SESSION_LIFE,
      endedAt: null,
      endedWhy: null,
    });
    state.lastCheckKey = key;
    state.lastOutcome = "signedIn";
    state.sessionId = request.session.id;
    return {
      outcome: "signedIn",
      signInAttemptId: attempt.id,
      personId,
      sessionId: request.session.id,
      sessionExpiresAt: utc(this.now + SESSION_LIFE),
      proofCodeId,
      repeated: false,
    };
  }

  /** The answer read from the attempt as a check left it (db/repo's fromAttempt, by K-05 item 60). */
  private fromAttempt(attempt: DoubleAttempt, state: DoubleCheckState, repeated: boolean): CheckAnswer {
    const signInAttemptId = attempt.id;
    const proofCodeId = attempt.proofCodeId;
    switch (state.lastOutcome) {
      case "wrong":
        return {
          outcome: "wrong",
          signInAttemptId,
          triesLeft: TRIES - state.wrongTries,
          proofCodeId,
          repeated,
        };
      case "paused":
        return {
          outcome: "paused",
          signInAttemptId,
          until: utc(attempt.pausedUntil ?? 0),
          proofCodeId,
          repeated,
        };
      case "expired":
        return { outcome: "expired", signInAttemptId, proofCodeId, repeated };
      case "secondProofNeeded":
        return {
          outcome: "secondProofNeeded",
          signInAttemptId,
          personId: attempt.personId ?? "",
          proofCodeId: proofCodeId ?? "",
          repeated,
        };
      default:
        return { outcome: "alreadySignedIn", signInAttemptId, repeated };
    }
  }

  // -- K-05 v1.13 items 61 to 63 -----------------------------------------------------------------------------------

  /** Item 61: session_for_token, then only that live session ends, signed_out. */
  endSession(request: EndSessionRequest): Promise<EndSessionOutcome> {
    this.calls.push("endSession");
    this.ends.push(structuredClone(request));
    const live = [...this.sessions.values()].find(
      (session) =>
        session.tokenSha256 === request.tokenSha256 &&
        session.endedAt === null &&
        session.expiresAt > this.now,
    );
    if (live === undefined) return this.gave({ result: "signedOut", repeated: true });
    live.endedAt = this.now;
    live.endedWhy = "signed_out";
    return this.gave({ result: "signedOut", repeated: false, sessionId: live.id, personId: live.personId });
  }

  /** Item 62: the person's standing as seeded (none: no role, no team row; tester is the team row: v1.12 rule). */
  personStanding(request: PersonStandingRequest): Promise<PersonStandingOutcome> {
    this.calls.push("personStanding");
    this.standingAsks.push(structuredClone(request));
    const scripted = this.scriptedStandings.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted !== undefined) return this.gave(scripted);
    const seeded = this.standings.get(request.personId);
    return this.gave({
      personId: request.personId,
      roles: (seeded?.roles ?? []).map(({ role, businessId }) => ({
        role: role as "owner" | "admin" | "staff" | "ownBusiness",
        businessId,
      })),
      team: seeded?.team ?? false,
      tester: seeded?.team ?? false,
    });
  }

  /** Item 63: one entry per change of each asked row not yet logged; an unknown row is notFound, nothing written. */
  signInEntries(request: SignInEntriesRequest): Promise<SignInEntriesOutcome> {
    this.calls.push("signInEntries");
    this.entryAsks.push(structuredClone(request));
    const scripted = this.scriptedEntries.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);
    if (scripted !== undefined) return this.gave(scripted);
    const called: { id: string; kind: "proof_code.checked" | "session.started" | "session.ended" }[] = [];
    for (const ask of request.entries) {
      if (ask.kind === "proof_code.checked") {
        const code = this.codes.get(ask.proofCodeId);
        if (code === undefined)
          return this.gave({ error: "notFound", table: "proof_codes", rowId: ask.proofCodeId });
        for (let try_ = 1; try_ <= code.wrongTries; try_ += 1)
          called.push({ id: `log-${code.id}-wrong-${String(try_)}`, kind: ask.kind });
        if (code.usedAt !== null) called.push({ id: `log-${code.id}-used`, kind: ask.kind });
      } else {
        const session = this.sessions.get(ask.sessionId);
        if (session === undefined)
          return this.gave({ error: "notFound", table: "sessions", rowId: ask.sessionId });
        if (ask.kind === "session.started") called.push({ id: `log-${session.id}-started`, kind: ask.kind });
        else if (session.endedAt !== null) called.push({ id: `log-${session.id}-ended`, kind: ask.kind });
      }
    }
    const entries = called.map(({ id, kind }) => {
      const written = !this.log.has(id);
      this.log.set(id, kind);
      return { id, kind, written };
    });
    return this.gave({ result: "logged", entries });
  }
}

// ---- one run's world ----------------------------------------------------------------------------------------------

/** The ports a call reaches, in order: the hashing port's calls beside the store's. */
export function recordingHash(hash: KeyedHash, calls: string[]): KeyedHash {
  return {
    keyName: hash.keyName,
    hmacHex(message) {
      calls.push("hmacHex");
      return hash.hmacHex(message);
    },
  };
}

/** One run's world: the double, T-1282's start's ports and this card's, and the work each `later` was handed. */
export interface CheckWorld {
  readonly double: SignInCheckDouble;
  /** The order the ports were reached in (the hashing port and the double). */
  readonly calls: string[];
  /** The start's random source: its ids from a counter, its codes from the draws given. */
  readonly startFill: TestFill;
  /** The checks' random source: the sessions' tokens and ids, from a counter of its own. */
  readonly checkFill: TestFill;
  readonly startDeps: SignInHandlerDeps;
  readonly deps: SignInCheckDeps;
  /** The code sends T-1282's handler handed to its `later`. */
  readonly sends: AfterAnswer[];
  /** The entries this card's handlers handed to their `later`. */
  readonly entries: EntriesAfterAnswer[];
}

export async function checkWorld(
  options: {
    readonly now?: string;
    readonly accounts?: readonly (readonly [string, string])[];
    readonly draws?: readonly number[];
    readonly checkRandom?: RandomFill;
  } = {},
): Promise<CheckWorld> {
  const calls: string[] = [];
  const double = new SignInCheckDouble(options.now ?? SIGN_IN_WRONG_FIVE.given.now, calls);
  for (const [key, person] of options.accounts ?? [[`email:${SAM_TYPED}`, SAM_PERSON] as const])
    double.account(key, person);
  const hash = recordingHash(await testHash(), calls);
  const startFill = testFill(options.draws ?? [CODE_DRAW]);
  const checkFill = testFill([], 128);
  const sends: AfterAnswer[] = [];
  const entries: EntriesAfterAnswer[] = [];
  return {
    double,
    calls,
    startFill,
    checkFill,
    startDeps: {
      store: double,
      hash,
      random: startFill.fill,
      later: (work) => {
        sends.push(work);
      },
    },
    deps: {
      check: double,
      afterCheck: double,
      hash,
      random: options.checkRandom ?? checkFill.fill,
      later: (work) => {
        entries.push(work);
      },
    },
    sends,
    entries,
  };
}
