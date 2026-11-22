// S1-10's read-only step writer at the walk (T-1533, the plan's T-636 re-scoped as T-636a; S1-10 slice card S10-3; K-09
// README defaults 210 and 211, with the lead's rulings DL-1167). It is a T-1461 StepWriter (actions/src/commit/walk/
// writes.ts): it reads, then returns StepRows, and the commit writes what writesOf returns in the turn's one commit, or
// nothing at all. The walk calls it as S1-10's writer whether S1-10 follows S1-09's owner branch or S1-76's (both rejoin
// at S1-10), and stops right after it (default 209: waitsOnEvent, no question, no clock). Nothing binds it here: the S1-09
// design ruling's card 7 binds it, only together with S1-09's settler and writers over one walk's readings (index.ts
// mobileIdSteps), with the stop reads, the link port and the face's link stage.
//
// What it reads, in this order (each check before anything is read where it can be): the step (wrongStep); the claim,
// owner or helper, only from S1-09's reading held on the turn object the walk hands every writer of the run (default
// 201; listing/settle.ts walkReadings), never from the words, the option decide named or a row, and with none held (or one
// that answered "ask") refused claimUnknown (open gap 200); the turn's person (noPerson); the turn's service through
// WriterContext.text() (an email turn: noNumberInChat; none: the walk's own noServiceOrChatId); for the owner's claim the
// stop reads and the link port bound (notBuilt otherwise); then item 79 (noCompany), item 26's handle (an email handle:
// noNumberInChat; the person not on the handle: noPerson; no phones row: noPhoneRow) and item 26's accounts row
// (reads.ts), and for the owner's claim the stop home last.
//
// What it writes, in this order (default 210):
//   (1) K-22 accounts, the caller's person's row (scope none: one sign-in for every company), as the lead rules it
//       (DL-1167 (2)): none on file, inserted with mobile the chat's number and mobile_proven_at the time of the turn's
//       last text; on file with mobile null, mobile and mobile_proven_at set at the version read; on file holding the
//       chat's number unproven, mobile_proven_at set at the version read; on file holding it proven, nothing written; on
//       file holding another number, refused mobileOnFile. email and email_proven_at are never written (D5). Another
//       person's account holding the number is the commit's accounts_mobile_key refusal (23505, answered constraint,
//       rolled back, nothing written, no one named: DL-1167 (1)); the writer reads no other person's account.
//   (2) For the owner's claim only, when the stop home lets Rosie text this owner (mayText; default 189): the secure
//       link's K-22 v1.1 page_links row (link.ts; default 211): id `link-s1-10-<turn key>-1`, the call's business, the
//       caller's person, purpose setup_id_check, step S1-10, the code's sha256 only, the turn's handle, issued at the
//       writer's clock and lapsing 7 days later, live (no end).
//   (3) With it, one quick reply naming S1-10 and line 2 (say[4], S1-10's third line from Rosie to the owner as bundle
//       v3 compiles it: "This is Rosie, an automated assistant, setting up {{biz.name}}. Your secure ID upload is
//       below. These texts are only about your business on Rosie."), to the turn's handle and person, under the call's
//       business, on the turn's service, no booking, no question and no plan.
//   The plain link goes nowhere but the face's stage (LinkStage), by the turn and that outbox row's id, replaced on every
//   gate run (row ids repeat across GATE_RUNS); the face moves it into its hold only on a committed answer with repeated
//   false (turn-face.ts), so finalize fills link.secure from it in the same run and a replay, a refusal or a conflict's
//   first run hands on no code. With no text allowed, neither the row nor the link is written, (1) still is.
// For the helper's claim: (1) alone, the helper's own accounts row by the same rules; no link and no row ("On the
// helper path it sets only the helper's own sign-in": line 182; default 214).
// It gives `mobile`, never `id_checked` (D2; the walk refuses it: eventKeyAtWalk). No event-log entry (K-08 v1.1 has no
// kind for an account's mobile or a link issued: open gap 1).
//
// Never logged: the number, the code or the link, in a span, a log line, an error, the unit's why or a row's plain
// columns (BP rule 7; K-21 "Never in a span or a log"). Nothing here logs; what it throws names its fault and the step
// alone (errors.ts), or is the walk's own refusal (WriterContext.text).
//
// Defaults used (for ops/QUESTIONS.md):
//   M1. The checks run in the order above, so a turn S1-10's writer cannot write for is refused before its company, its
//       handle or its account is read, and the owner's ports are checked before any read.
//   M2. "The time of the turn's last text" (default 210) is the sentAt.utc of the last of the decided context's texts,
//       whatever its kind: every one came from the turn's own handle.
//   M3. The link's issued_at is the writer's clock read once per call, to the second; expires_at is 7 days after it.
//   M4. mobile is given on every write that reaches the accounts row, including the one that writes nothing because the
//       chat's number is on file proven.

import type { CommitTurnContext, OutboxRowNew, StateWrite } from "../../../commit";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import type { SetupKey } from "../../../gate/framework";
import { mayText, readStop, type StopHomeReads } from "../../../homes/stop";
import type { RandomFill } from "../../../domain/proof-codes";
import type { ListingReading, WalkReadings } from "../listing/settle";
import { MobileIdNotBuiltError, MobileIdRefusedError } from "./errors";
import { codeSha256, isLinkPlace, linkLifeOf, mintCode, secureLinkOf, type LinkPlace } from "./link";
import type { AccountOnFile, MobileIdReads } from "./reads";

/** The step this writer writes. */
export const MOBILE_ID_STEP = "S1-10";

/** The secure link's line (K-05 v1.22 lineNo): S1-10's third line from Rosie to the owner, say[4] (default 210). */
export const SECURE_LINK_LINE = 2;

/** The key S1-10's writer gives (K-01 v1 step.gives: id_checked and mobile; never id_checked at the walk). */
export const MOBILE: SetupKey = "mobile";

/** The link's purpose (K-22 v1.1 page_links_purpose_step: setup_id_check with S1-10). */
export const SETUP_ID_CHECK = "setup_id_check";

/** The services whose chat carries the texter's number (K-06 v1 service; default 135): every one but email. */
const NUMBER_SERVICES: readonly string[] = ["imessage", "rcs", "sms"];

/**
 * Where the writer leaves the plain link for the turn face (turn-face/held.ts HeldLinks): by the turn and the id of the
 * outbox row that carries it, replaced at the same row id. The face moves it into its hold only on a fresh commit.
 */
export interface LinkStage {
  stage(turnId: string, outboxRowId: string, link: string): void;
}

/** The secure link's port, bound by the wiring (card 7): the link's place, the stage, the generator and the clock. */
export interface SecureLinkDeps extends LinkPlace {
  /** The face's stage (turn-face/held.ts HeldLinks), shared with the face that holds the code for finalize. */
  readonly stage: LinkStage;
  /** The writer's clock, read once per call: the link's issued_at. */
  readonly now: () => Date;
  /** The secure generator. Default: crypto.getRandomValues (domain/proof-codes WEB_CRYPTO_FILL). */
  readonly fill?: RandomFill;
}

/** What S1-10's writer reads with, bound by the wiring (card 7); a port left out fails the step closed. */
export interface MobileIdWriterDeps<Repo = unknown> {
  /** Item 79 and item 26 (reads.ts): the turn's company, the turn's handle and the caller's accounts row. */
  readonly reads: MobileIdReads<Repo>;
  /** The stop home's reads, bound on the runtime side. Left out: the owner's claim answers notBuilt (stopNotWired). */
  readonly stop?: StopHomeReads;
  /** The secure link's port. Left out, or not a link's place: the owner's claim answers notBuilt (linkNotWired). */
  readonly link?: SecureLinkDeps;
}

/** The claim S1-09's reading holds for this walk and part; claimUnknown when none is held or it answered "ask". */
async function claimOf<Repo>(
  readings: WalkReadings<Repo>,
  call: StepWriterCall<Repo>,
): Promise<ListingReading["claim"]> {
  const held = readings.held(call.writer.turn, call.part.index);
  if (held === null) throw new MobileIdRefusedError("claimUnknown", [MOBILE_ID_STEP]);
  const reading = await held;
  if (reading.outcome !== "branch") throw new MobileIdRefusedError("claimUnknown", [MOBILE_ID_STEP]);
  return reading.claim;
}

/** The turn's person (K-09 caller.personId, the turn party's). */
function personOf<Repo>(turn: CommitTurnContext<Repo>): string {
  const { personId } = turn.request.caller;
  if (personId === null) throw new MobileIdRefusedError("noPerson", [MOBILE_ID_STEP]);
  return personId;
}

/** The decided texts of the turn (the walk refuses any other input before a writer is called). */
function textsOf<Repo>(call: StepWriterCall<Repo>) {
  const { input } = call.writer.turn.request;
  return input.kind === "decided" ? input.decided.context.texts : [];
}

/** Default M2: the time of the turn's last text, when the owner's own text from the number proved it. */
function provenAtOf<Repo>(call: StepWriterCall<Repo>): string {
  const last = textsOf(call).at(-1);
  if (last === undefined) throw new MobileIdRefusedError("noNumberInChat", [MOBILE_ID_STEP]);
  return last.sentAt.utc;
}

/** The owner's ports, bound, or notBuilt before anything is read. */
function ownerPortsOf<Repo>(deps: MobileIdWriterDeps<Repo>): { stop: StopHomeReads; link: SecureLinkDeps } {
  const { stop, link } = deps;
  if (stop === undefined) throw new MobileIdNotBuiltError("gateAndCommit", "stopNotWired", [MOBILE_ID_STEP]);
  if (link === undefined || !isLinkPlace(link)) {
    throw new MobileIdNotBuiltError("gateAndCommit", "linkNotWired", [MOBILE_ID_STEP]);
  }
  return { stop, link };
}

/** Item 1 of default 210: the caller's accounts row, as the lead rules it (DL-1167 (2)). */
function accountWrites(
  personId: string,
  number: string,
  provenAt: string,
  onFile: AccountOnFile | null,
): StateWrite[] {
  if (onFile === null) {
    return [
      {
        op: "insert",
        table: "accounts",
        values: { person_id: personId, mobile: number, mobile_proven_at: provenAt },
      },
    ];
  }
  const key = { person_id: personId };
  if (onFile.mobile === null) {
    return [
      {
        op: "update",
        table: "accounts",
        key,
        expectVersion: onFile.version,
        set: { mobile: number, mobile_proven_at: provenAt },
      },
    ];
  }
  if (onFile.mobile !== number) throw new MobileIdRefusedError("mobileOnFile", [MOBILE_ID_STEP]);
  if (onFile.mobileProvenAt === null) {
    return [
      {
        op: "update",
        table: "accounts",
        key,
        expectVersion: onFile.version,
        set: { mobile_proven_at: provenAt },
      },
    ];
  }
  return [];
}

/** Whether the turn batches texts from its own handle: its decided texts hold a text (homes/stop TurnRef.texted). */
function textedIn<Repo>(call: StepWriterCall<Repo>): boolean {
  return textsOf(call).some((text) => text.kind === "text");
}

/**
 * S1-10's read-only step writer over `deps` and one walk's readings (the top of this file). Throws MobileIdRefusedError,
 * MobileIdNotBuiltError, MobileIdReadError, the walk's WalkRefusedError (noServiceOrChatId, through WriterContext.text),
 * or what a read port, readStop or mayText throws: the call then fails closed with nothing written.
 */
export function mobileIdWriter<Repo = unknown>(
  deps: MobileIdWriterDeps<Repo>,
  readings: WalkReadings<Repo>,
): StepWriter<Repo> {
  return async (call) => {
    if (call.step.id !== MOBILE_ID_STEP) {
      throw new MobileIdRefusedError("wrongStep", [MOBILE_ID_STEP, call.step.id]);
    }
    const claim = await claimOf(readings, call);
    const { turn } = call.writer;
    const personId = personOf(turn);
    const { service } = call.writer.text();
    if (!NUMBER_SERVICES.includes(service))
      throw new MobileIdRefusedError("noNumberInChat", [MOBILE_ID_STEP]);
    const provenAt = provenAtOf(call);
    const owner = claim === "owner" ? ownerPortsOf(deps) : null;

    // Whose rows (default 210): the caller's person owns the company the turn runs under, whose business is the call's.
    const { businessId } = turn;
    const company = await deps.reads.turnCompany({ businessId, personId });
    if (company === null) throw new MobileIdRefusedError("noCompany", [MOBILE_ID_STEP]);
    const handleId = turn.turn.handleId;
    const handle = await deps.reads.turnHandle(call.repo, { handleId, businessId });
    if (handle.kind !== "phone") throw new MobileIdRefusedError("noNumberInChat", [MOBILE_ID_STEP]);
    if (!handle.people.includes(personId)) throw new MobileIdRefusedError("noPerson", [MOBILE_ID_STEP]);
    const number = handle.phoneNumber;
    if (number === null) throw new MobileIdRefusedError("noPhoneRow", [MOBILE_ID_STEP]);
    const onFile = await deps.reads.account(call.repo, { handleId, businessId, personId });
    const state = accountWrites(personId, number, provenAt, onFile);
    const rows = (more: readonly StateWrite[], messages: readonly OutboxRowNew[]): StepRows => ({
      state: [...state, ...more],
      stateEvents: [],
      gives: [MOBILE],
      asks: [],
      messages,
    });
    if (owner === null) return rows([], []);

    // The owner's ID text, only when the stop home lets Rosie text this owner (default 189).
    const reading = await readStop(owner.stop, { personId, businessId, handleId });
    const decision = mayText(reading, {
      sendClass: "quick_reply",
      bookingId: null,
      turn: { id: turn.turn.id, handleId, texted: textedIn(call) },
    });
    if (decision.ruling === "noTexts") return rows([], []);

    const { link } = owner;
    const { issuedAt, expiresAt } = linkLifeOf(link.now());
    const code = mintCode(link.fill);
    const linkRowId = call.writer.rowId("link");
    const outboxRowId = call.writer.rowId("outbox");
    const pageLink: StateWrite = {
      op: "insert",
      table: "page_links",
      values: {
        id: linkRowId,
        business_id: businessId,
        person_id: personId,
        purpose: SETUP_ID_CHECK,
        step_id: MOBILE_ID_STEP,
        code_sha256: await codeSha256(code),
        sent_to_handle_id: handleId,
        issued_at: issuedAt,
        expires_at: expiresAt,
      },
    };
    const message: OutboxRowNew = {
      id: outboxRowId,
      recipientHandleId: handleId,
      recipientPersonId: personId,
      businessId,
      bookingId: null,
      channel: service,
      sendClass: "quick_reply",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
      step: MOBILE_ID_STEP,
      lineNo: SECURE_LINK_LINE,
    };
    // The plain link waits in the face's stage by the turn and the row that carries it, replaced on every gate run.
    link.stage.stage(turn.turn.id, outboxRowId, secureLinkOf(link, code));
    return rows([pageLink], [message]);
  };
}
